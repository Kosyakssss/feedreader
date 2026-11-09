package main

import (
	"bytes"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"html"
	"io"
	"net/url"
	"regexp"
	"strings"
	"time"
)

type Item struct {
	GUID, URL, Title, Text, Body string
	Published                    int64
}

type ParsedFeed struct {
	Format, Title string
	Items         []Item
}

const maxBody = 200_000

const (
	atomNS = "http://www.w3.org/2005/Atom"
	rss1NS = "http://purl.org/rss/1.0/"
	rss09  = "http://my.netscape.com/rdf/simple/0.9/"
)

// node is a generic XML element. Feeds vary too much for fixed structs: a
// media:title must not be mistaken for the title, so children are picked by
// name and namespace.
type node struct {
	XMLName xml.Name
	Attrs   []xml.Attr `xml:",any,attr"`
	Text    string     `xml:",chardata"`
	Inner   string     `xml:",innerxml"`
	Kids    []node     `xml:",any"`
}

func (n node) standard() bool {
	s := n.XMLName.Space
	return s == "" || s == atomNS || s == rss1NS || s == rss09
}

func (n node) kid(names ...string) *node {
	for _, name := range names {
		for i := range n.Kids {
			if n.Kids[i].XMLName.Local == name && n.Kids[i].standard() {
				return &n.Kids[i]
			}
		}
	}
	return nil
}

// extension finds a child in any namespace, such as content:encoded or dc:date.
func (n node) extension(name string) *node {
	for i := range n.Kids {
		if n.Kids[i].XMLName.Local == name {
			return &n.Kids[i]
		}
	}
	return nil
}

func (n node) attr(name string) string {
	for _, a := range n.Attrs {
		if a.Name.Local == name {
			return strings.TrimSpace(a.Value)
		}
	}
	return ""
}

func (n *node) text() string {
	if n == nil {
		return ""
	}
	return strings.TrimSpace(html.UnescapeString(n.Text))
}

// markup returns a body field as HTML, whichever way the feed carried it.
func (n *node) markup() string {
	if n == nil {
		return ""
	}
	if n.attr("type") == "xhtml" {
		return strings.TrimSpace(n.Inner)
	}
	return strings.TrimSpace(n.Text)
}

func (n node) link() string {
	var fallback string
	for i := range n.Kids {
		k := &n.Kids[i]
		if k.XMLName.Local != "link" || !k.standard() {
			continue
		}
		if t := k.text(); t != "" {
			return t
		}
		href := k.attr("href")
		if rel := k.attr("rel"); rel == "alternate" && href != "" {
			return href
		}
		if fallback == "" && (k.attr("rel") == "" || len(n.Kids) == 1) {
			fallback = href
		}
	}
	return fallback
}

func parseFeed(data []byte, base string) (ParsedFeed, error) {
	data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))
	if trimmed := bytes.TrimSpace(data); len(trimmed) > 0 && trimmed[0] == '{' {
		return parseJSONFeed(trimmed, base)
	}
	dec := xml.NewDecoder(bytes.NewReader(data))
	dec.Strict = false
	dec.Entity = xml.HTMLEntity
	dec.CharsetReader = charsetReader
	var root node
	if err := dec.Decode(&root); err != nil {
		return ParsedFeed{}, fmt.Errorf("unreadable feed: %w", err)
	}
	var out ParsedFeed
	switch strings.ToLower(root.XMLName.Local) {
	case "rss":
		out.Format = "rss"
		channel := root.kid("channel")
		if channel == nil {
			return out, nil
		}
		out.Title = channel.kid("title").text()
		for _, item := range channel.Kids {
			if item.XMLName.Local == "item" {
				out.Items = append(out.Items, rssItem(item, item.kid("guid").text(), base))
			}
		}
	case "rdf":
		out.Format = "rdf"
		out.Title = root.kid("channel").kid("title").text()
		for _, item := range root.Kids {
			if item.XMLName.Local == "item" {
				out.Items = append(out.Items, rssItem(item, html.UnescapeString(item.attr("about")), base))
			}
		}
	case "feed":
		out.Format = "atom"
		out.Title = root.kid("title").text()
		for _, entry := range root.Kids {
			if entry.XMLName.Local != "entry" {
				continue
			}
			body := entry.kid("content").markup()
			if body == "" {
				body = entry.kid("summary").markup()
			}
			link := entry.link()
			id := entry.kid("id").text()
			if id == "" {
				id = link
			}
			out.Items = append(out.Items, buildItem(id, link, entry.kid("title").text(), body, firstDate(entry.kid("published").text(), entry.kid("updated").text()), base))
		}
	default:
		return out, fmt.Errorf("unrecognized feed format")
	}
	return out, nil
}

func rssItem(item node, guid, base string) Item {
	link := item.link()
	if guid == "" {
		guid = link
	}
	body := item.extension("encoded").markup()
	if body == "" {
		body = item.kid("description").markup()
	}
	return buildItem(guid, link, item.kid("title").text(), body, firstDate(item.kid("pubDate").text(), item.extension("date").text()), base)
}

func parseJSONFeed(data []byte, base string) (ParsedFeed, error) {
	var feed struct {
		Version, Title string
		Items          []struct {
			ID, URL, Title, Summary string
			ExternalURL             string `json:"external_url"`
			HTML                    string `json:"content_html"`
			Text                    string `json:"content_text"`
			Published               string `json:"date_published"`
			Modified                string `json:"date_modified"`
		}
	}
	if err := json.Unmarshal(data, &feed); err != nil {
		return ParsedFeed{}, fmt.Errorf("unreadable JSON feed: %w", err)
	}
	if !strings.HasPrefix(feed.Version, "https://jsonfeed.org/version/") {
		return ParsedFeed{}, fmt.Errorf("unrecognized feed format")
	}
	out := ParsedFeed{Format: "json", Title: feed.Title}
	for _, it := range feed.Items {
		link := it.URL
		if link == "" {
			link = it.ExternalURL
		}
		id := it.ID
		if id == "" {
			id = link
		}
		body := it.HTML
		if body == "" {
			body = it.Text
		}
		if body == "" {
			body = it.Summary
		}
		out.Items = append(out.Items, buildItem(id, link, it.Title, body, firstDate(it.Published, it.Modified), base))
	}
	return out, nil
}

func buildItem(guid, link, title, body string, published int64, base string) Item {
	safe := safeLink(link, base)
	if guid == "" {
		guid = safe
	}
	if guid == "" {
		guid = title
	}
	if len(body) > maxBody {
		body = strings.ToValidUTF8(body[:maxBody], "")
	}
	return Item{GUID: guid, URL: safe, Title: cleanTitle(title, safe), Text: plain(body), Body: body, Published: published}
}

func safeLink(link, base string) string {
	u, err := url.Parse(strings.TrimSpace(link))
	if err != nil {
		return ""
	}
	if b, err := url.Parse(base); err == nil {
		u = b.ResolveReference(u)
	}
	if (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return ""
	}
	return u.String()
}

// cleanTitle returns "" when a feed's title says nothing, so the row shows the
// entry's text instead.
func cleanTitle(title, link string) string {
	title = strings.Join(strings.Fields(title), " ")
	switch strings.ToLower(title) {
	case "untitled", "(untitled)", "no title", "(no title)", "[no title]":
		return ""
	}
	if title == link {
		return ""
	}
	return title
}

var (
	invisible = regexp.MustCompile(`(?is)<script.*?</script>|<style.*?</style>|<!--.*?-->`)
	tag       = regexp.MustCompile(`<[^>]*>`)
)

// plain turns a body of HTML into one line of text.
func plain(markup string) string {
	text := tag.ReplaceAllString(invisible.ReplaceAllString(markup, " "), " ")
	return strings.Join(strings.Fields(html.UnescapeString(text)), " ")
}

var dateLayouts = []string{
	time.RFC1123Z, time.RFC1123, time.RFC3339Nano, time.RFC3339, time.RFC822Z, time.RFC822,
	"Mon, 2 Jan 2006 15:04:05 -0700", "Mon, 2 Jan 2006 15:04:05 MST", "Mon, 2 Jan 2006 15:04 -0700", "Mon, 2 Jan 2006 15:04 MST",
	"2 Jan 2006 15:04:05 -0700", "2 Jan 2006 15:04:05 MST", "2 Jan 2006 15:04 -0700", "2 Jan 2006 15:04 MST",
	"Mon, 02 Jan 06 15:04:05 -0700", "Mon, 02 Jan 06 15:04:05 MST",
	"2006-01-02T15:04:05-0700", "2006-01-02T15:04:05", "2006-01-02 15:04:05 -0700", "2006-01-02 15:04:05", "2006-01-02",
}

// Go reads an unknown zone abbreviation as offset zero, so name the common ones.
var zoneHours = map[string]int{"EST": -5, "EDT": -4, "CST": -6, "CDT": -5, "MST": -7, "MDT": -6, "PST": -8, "PDT": -7}

func parseDate(value string) int64 {
	value = strings.TrimSpace(value)
	for _, layout := range dateLayouts {
		t, err := time.Parse(layout, value)
		if err != nil {
			continue
		}
		if name, offset := t.Zone(); offset == 0 {
			if hours, ok := zoneHours[name]; ok {
				t = t.Add(-time.Duration(hours) * time.Hour)
			}
		}
		return t.UnixMilli()
	}
	return 0
}

func firstDate(values ...string) int64 {
	for _, value := range values {
		if ms := parseDate(value); ms != 0 {
			return ms
		}
	}
	return 0
}

func charsetReader(label string, input io.Reader) (io.Reader, error) {
	switch strings.ToLower(label) {
	case "utf-8", "utf8", "us-ascii", "ascii":
		return input, nil
	case "iso-8859-1", "latin1", "windows-1252", "cp1252":
		data, err := io.ReadAll(input)
		if err != nil {
			return nil, err
		}
		runes := make([]rune, len(data))
		for i, b := range data {
			runes[i] = rune(b)
		}
		return strings.NewReader(string(runes)), nil
	}
	return nil, fmt.Errorf("unsupported charset %s", label)
}
