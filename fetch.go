package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/rand/v2"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	base         = 5 * time.Minute
	quietMax     = 60 * time.Minute
	quietFactor  = 48
	maxWait      = 6 * time.Hour
	wakeSpread   = 5 * time.Second
	sameHostGap  = time.Second
	startSpread  = 60 * time.Second
	waitSpread   = 30 * time.Second
	wokeLate     = 30 * time.Second
	maxFeedBytes = 10 << 20
	userAgent    = "Feedreader/0.3"
	acceptFeeds  = "application/rss+xml, application/atom+xml, application/feed+json, application/xml, text/xml"
)

type Result struct {
	Items              []Item
	Title, Error       string
	ETag, LastModified string
	RetryAfter, MaxAge time.Duration
}

// Feeds come from the open internet, so refuse to connect to anything on this
// machine or its private networks, even after a redirect.
var cgnat = netip.MustParsePrefix("100.64.0.0/10")

func publicOnly(_, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return err
	}
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || cgnat.Contains(ip) {
		return errors.New("not a public address")
	}
	return nil
}

var client = &http.Client{
	Timeout: 20 * time.Second,
	Transport: &http.Transport{
		DialContext:         (&net.Dialer{Timeout: 10 * time.Second, Control: publicOnly}).DialContext,
		TLSHandshakeTimeout: 10 * time.Second,
		MaxIdleConnsPerHost: 2,
		IdleConnTimeout:     30 * time.Second,
	},
	CheckRedirect: func(_ *http.Request, via []*http.Request) error {
		if len(via) > 5 {
			return errors.New("too many redirects")
		}
		return nil
	},
}

func fetchSource(source Source) Result {
	if source.Kind == "atproto" {
		return fetchAtproto(source.Ref, source.FetchedAt.Int64)
	}
	return fetchRSS(source)
}

func fetchRSS(source Source) Result {
	req, err := http.NewRequest("GET", source.Ref, nil)
	if err != nil {
		return Result{Error: err.Error()}
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", acceptFeeds)
	if source.ETag != "" {
		req.Header.Set("If-None-Match", source.ETag)
	}
	if source.LastModified != "" {
		req.Header.Set("If-Modified-Since", source.LastModified)
	}
	res, err := client.Do(req)
	if err != nil {
		return Result{Error: err.Error()}
	}
	defer res.Body.Close()
	out := Result{RetryAfter: retryAfter(res.Header.Get("Retry-After")), MaxAge: maxAge(res.Header.Get("Cache-Control"))}
	if res.StatusCode == http.StatusNotModified {
		out.ETag, out.LastModified = source.ETag, source.LastModified
		return out
	}
	if res.StatusCode != http.StatusOK {
		out.Error = "HTTP " + strconv.Itoa(res.StatusCode)
		return out
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, maxFeedBytes+1))
	if err != nil {
		out.Error = err.Error()
		return out
	}
	if len(data) > maxFeedBytes {
		out.Error = "feed too large"
		return out
	}
	parsed, err := parseFeed(data, res.Request.URL.String())
	if err != nil {
		out.Error = err.Error()
		return out
	}
	out.Items, out.Title = parsed.Items, parsed.Title
	out.ETag, out.LastModified = res.Header.Get("ETag"), res.Header.Get("Last-Modified")
	return out
}

func retryAfter(value string) time.Duration {
	if value == "" {
		return 0
	}
	if seconds, err := strconv.Atoi(strings.TrimSpace(value)); err == nil {
		return time.Duration(seconds) * time.Second
	}
	if t, err := http.ParseTime(value); err == nil {
		return time.Until(t)
	}
	return 0
}

var maxAgePattern = regexp.MustCompile(`(?i)max-age=(\d+)`)

func maxAge(value string) time.Duration {
	if m := maxAgePattern.FindStringSubmatch(value); m != nil {
		seconds, _ := strconv.Atoi(m[1])
		return time.Duration(seconds) * time.Second
	}
	return 0
}

func clamp(v, ceiling time.Duration) time.Duration { return min(max(v, base), ceiling) }

func earliestAfter(r Result, failures int) time.Duration {
	if r.RetryAfter > 0 {
		return clamp(r.RetryAfter, maxWait)
	}
	if r.Error != "" {
		wait := maxWait
		if failures < 12 {
			wait = min(base<<failures, maxWait)
		}
		return wait
	}
	if r.MaxAge > 0 {
		return clamp(r.MaxAge, maxWait)
	}
	return base
}

// restFor keeps quiet feeds asleep longer: a feed silent for two days is
// fetched hourly, one that posted today every few minutes.
func restFor(quietFor, earliest time.Duration) time.Duration {
	return max(earliest, clamp(quietFor/quietFactor, quietMax))
}

type loop struct {
	wake     chan struct{}
	earliest time.Time
}

type Fetcher struct {
	store     *Store
	onChange  func(sourceID int64, added int)
	mu        sync.Mutex
	loops     map[int64]*loop
	hostNext  map[string]time.Time
	lastNudge time.Time
}

func newFetcher(store *Store, onChange func(int64, int)) *Fetcher {
	return &Fetcher{store: store, onChange: onChange, loops: map[int64]*loop{}, hostNext: map[string]time.Time{}}
}

func (f *Fetcher) startAll() error {
	sources, err := f.store.sources()
	if err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, source := range sources {
		l := &loop{wake: make(chan struct{}, 1)}
		f.loops[source.ID] = l
		go f.run(source.ID, l)
	}
	return nil
}

// nudge wakes every feed that is allowed to fetch again. Opening the app calls
// this, at most once per base interval.
func (f *Fetcher) nudge() {
	f.mu.Lock()
	defer f.mu.Unlock()
	now := time.Now()
	if now.Sub(f.lastNudge) < base {
		return
	}
	f.lastNudge = now
	for _, l := range f.loops {
		if now.After(l.earliest) {
			select {
			case l.wake <- struct{}{}:
			default:
			}
		}
	}
}

func (f *Fetcher) turn(host string) {
	f.mu.Lock()
	start := time.Now()
	if next := f.hostNext[host]; next.After(start) {
		start = next
	}
	f.hostNext[host] = start.Add(sameHostGap)
	f.mu.Unlock()
	time.Sleep(time.Until(start))
}

func spread(d time.Duration) time.Duration { return time.Duration(rand.Int64N(int64(d))) }

func rest(l *loop, d time.Duration) (woken bool) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return false
	case <-l.wake:
		return true
	}
}

func (f *Fetcher) run(id int64, l *loop) {
	source, err := f.store.source(id)
	if err != nil {
		log.Printf("feed %d: %v", id, err)
		return
	}
	if source.FetchedAt.Valid {
		wait := max(0, time.Until(time.UnixMilli(source.NextAt.Int64)))
		rest(l, wait+spread(startSpread))
	}
	for {
		source, err := f.store.source(id)
		if err != nil {
			log.Printf("feed %d: %v", id, err)
			return
		}
		host := "atproto"
		if source.Kind == "rss" {
			if u, err := url.Parse(source.Ref); err == nil {
				host = u.Hostname()
			}
		}
		f.turn(host)
		result := fetchSource(source)
		failures := 0
		if result.Error != "" {
			failures = source.Failures + 1
		}
		earliest := earliestAfter(result, failures)
		f.mu.Lock()
		l.earliest = time.Now().Add(earliest)
		f.mu.Unlock()
		quiet := time.Duration(0)
		if source.Kind == "rss" {
			quiet = time.Since(time.UnixMilli(f.store.lastPost(id)))
		}
		wait := restFor(quiet, earliest)
		changed, err := f.store.save(source, result, failures, time.Now().Add(wait).UnixMilli())
		if err != nil {
			log.Printf("feed %s: save: %v", source.Label, err)
		} else if changed > 0 || source.Error != result.Error {
			f.onChange(id, changed)
		}
		asleep := wait + spread(waitSpread)
		started := time.Now()
		if rest(l, asleep) {
			time.Sleep(spread(wakeSpread))
		} else if time.Since(started)-asleep > wokeLate {
			time.Sleep(spread(startSpread)) // the Mac slept; don't fetch everything at once
		}
	}
}

// Bluesky: posts are read straight from each account's public data server.

type identity struct{ pds, handle string }

var (
	identities   = map[string]identity{}
	identitiesMu sync.Mutex
)

func getJSON(target string, into any) error {
	req, err := http.NewRequest("GET", target, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", res.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(into)
}

func resolveIdentity(did string) (identity, error) {
	identitiesMu.Lock()
	known, ok := identities[did]
	identitiesMu.Unlock()
	if ok {
		return known, nil
	}
	target := "https://plc.directory/" + did
	if strings.HasPrefix(did, "did:web:") {
		target = "https://" + strings.TrimPrefix(did, "did:web:") + "/.well-known/did.json"
	}
	var doc struct {
		Service []struct {
			ID              string `json:"id"`
			ServiceEndpoint string `json:"serviceEndpoint"`
		} `json:"service"`
		AlsoKnownAs []string `json:"alsoKnownAs"`
	}
	if err := getJSON(target, &doc); err != nil {
		return identity{}, err
	}
	found := identity{handle: did}
	for _, s := range doc.Service {
		if strings.HasSuffix(s.ID, "atproto_pds") {
			found.pds = s.ServiceEndpoint
		}
	}
	if found.pds == "" {
		return identity{}, errors.New("no data server for this account")
	}
	for _, aka := range doc.AlsoKnownAs {
		if strings.HasPrefix(aka, "at://") {
			found.handle = strings.TrimPrefix(aka, "at://")
			break
		}
	}
	identitiesMu.Lock()
	identities[did] = found
	identitiesMu.Unlock()
	return found, nil
}

type bskyRef struct {
	URI string `json:"uri"`
}

type bskyEmbed struct {
	External *bskyRef `json:"external"`
	Record   *struct {
		URI    string   `json:"uri"`
		Record *bskyRef `json:"record"`
	} `json:"record"`
	Video *json.RawMessage `json:"video"`
	Media *struct {
		Video *json.RawMessage `json:"video"`
	} `json:"media"`
}

type bskyPost struct {
	Text      string     `json:"text"`
	CreatedAt string     `json:"createdAt"`
	Reply     *struct{}  `json:"reply"`
	Embed     *bskyEmbed `json:"embed"`
	Subject   *bskyRef   `json:"subject"`
}

func fetchRecord(uri string) (handle string, did string, post bskyPost, ok bool) {
	parts := strings.Split(strings.TrimPrefix(uri, "at://"), "/")
	if len(parts) != 3 {
		return
	}
	who, err := resolveIdentity(parts[0])
	if err != nil {
		return
	}
	var found struct {
		Value bskyPost `json:"value"`
	}
	target := fmt.Sprintf("%s/xrpc/com.atproto.repo.getRecord?repo=%s&collection=%s&rkey=%s", who.pds, parts[0], parts[1], parts[2])
	if getJSON(target, &found) != nil {
		return
	}
	return who.handle, parts[0], found.Value, true
}

func describe(post bskyPost) string {
	text := post.Text
	if e := post.Embed; e != nil {
		if e.External != nil && e.External.URI != "" && !strings.Contains(text, e.External.URI) {
			text += "\n" + e.External.URI
		}
		if e.Record != nil {
			uri := e.Record.URI
			if e.Record.Record != nil {
				uri = e.Record.Record.URI
			}
			if uri != "" {
				if handle, _, quoted, ok := fetchRecord(uri); ok && quoted.Text != "" {
					text += "\n\n@" + handle + ": " + quoted.Text
				}
			}
		}
		if e.Video != nil || (e.Media != nil && e.Media.Video != nil) {
			text += "\n\n[video]"
		}
	}
	return strings.TrimSpace(text)
}

func postURL(uri string) string {
	parts := strings.Split(strings.TrimPrefix(uri, "at://"), "/")
	if len(parts) != 3 {
		return ""
	}
	return "https://bsky.app/profile/" + parts[0] + "/post/" + parts[2]
}

func fetchAtproto(did string, since int64) Result {
	who, err := resolveIdentity(did)
	if err != nil {
		return Result{Error: err.Error()}
	}
	list := func(collection string) ([]struct {
		URI   string   `json:"uri"`
		Value bskyPost `json:"value"`
	}, error) {
		var page struct {
			Records []struct {
				URI   string   `json:"uri"`
				Value bskyPost `json:"value"`
			} `json:"records"`
		}
		err := getJSON(fmt.Sprintf("%s/xrpc/com.atproto.repo.listRecords?repo=%s&collection=%s&limit=50", who.pds, did, collection), &page)
		return page.Records, err
	}
	posts, err := list("app.bsky.feed.post")
	if err != nil {
		return Result{Error: err.Error()}
	}
	reposts, err := list("app.bsky.feed.repost")
	if err != nil {
		return Result{Error: err.Error()}
	}
	fresh := func(ms int64) bool { return since == 0 || ms >= since-86_400_000 }
	var out Result
	for _, record := range posts {
		if record.Value.Reply != nil {
			continue
		}
		published := parseDate(record.Value.CreatedAt)
		text := record.Value.Text
		if fresh(published) {
			text = describe(record.Value)
		}
		if text == "" {
			text = "[post]"
		}
		out.Items = append(out.Items, Item{GUID: record.URI, URL: postURL(record.URI), Text: strings.Join(strings.Fields(text), " "), Published: published})
	}
	for _, record := range reposts {
		published := parseDate(record.Value.CreatedAt)
		if record.Value.Subject == nil || !fresh(published) {
			continue
		}
		handle, _, target, ok := fetchRecord(record.Value.Subject.URI)
		if !ok {
			continue
		}
		text := "Reposted @" + handle + ": " + describe(target)
		out.Items = append(out.Items, Item{GUID: record.URI, URL: postURL(record.Value.Subject.URI), Text: strings.Join(strings.Fields(text), " "), Published: published})
	}
	return out
}

func resolveHandle(handle string) (string, error) {
	records, _ := net.DefaultResolver.LookupTXT(context.Background(), "_atproto."+handle)
	for _, record := range records {
		if strings.HasPrefix(record, "did=") {
			return strings.TrimPrefix(record, "did="), nil
		}
	}
	res, err := client.Get("https://" + handle + "/.well-known/atproto-did")
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 2048))
	if err != nil {
		return "", err
	}
	did := strings.TrimSpace(string(data))
	if res.StatusCode != http.StatusOK || !strings.HasPrefix(did, "did:") {
		return "", errors.New("could not find that account")
	}
	return did, nil
}

// discover turns what a person typed into a source to store.
func discover(input string) (kind, ref, label string, err error) {
	raw := strings.TrimSpace(input)
	actor := ""
	switch {
	case strings.HasPrefix(raw, "did:"):
		actor = raw
	case strings.HasPrefix(raw, "@"):
		actor = raw[1:]
	case strings.Contains(raw, "bsky.app/profile/"):
		actor = strings.SplitN(strings.SplitN(raw, "bsky.app/profile/", 2)[1], "/", 2)[0]
	}
	if actor != "" {
		did := actor
		if !strings.HasPrefix(did, "did:") {
			if did, err = resolveHandle(actor); err != nil {
				return
			}
		}
		who, e := resolveIdentity(did)
		if e != nil {
			return "", "", "", e
		}
		return "atproto", did, "@" + who.handle, nil
	}
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	source := Source{Kind: "rss", Ref: raw}
	result := fetchRSS(source)
	if result.Error != "" {
		return "", "", "", errors.New(result.Error)
	}
	label = result.Title
	if label == "" {
		label = raw
	}
	return "rss", raw, label, nil
}
