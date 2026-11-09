package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"html/template"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
)

//go:embed web
var webFiles embed.FS

// maxTitle caps what a row carries. Very long text keeps its true start and
// true end, so the part that says how it ends can still be shown.
const maxTitle = 240

type Row struct {
	ID, SourceID    int64
	Feed, URL, Date string
	Saved           bool
	Title           string
}

type NavLink struct {
	Href, Label string
	Current     bool
}

// Page is everything a template needs. Kind is "unread", "list", "feeds" or "search".
type Page struct {
	Kind, Path, Heading string
	Version             string
	Nav                 []NavLink
	Rows                []Row
	Feeds               []Source
	Query               string
	MaxID               int64
}

type builtPage struct {
	etag string
	gz   []byte
}

type asset struct {
	contentType string
	gz          []byte
}

type Server struct {
	store   *Store
	fetcher *Fetcher
	tmpl    *template.Template
	version string
	buildMu sync.Mutex
	pages   atomic.Pointer[map[string]*builtPage]
}

func displayTitle(title, text, link string) string {
	if title != "" {
		return title
	}
	if text != "" {
		return text
	}
	return link
}

func capTitle(text string) string {
	runes := []rune(text)
	if len(runes) <= maxTitle {
		return text
	}
	keep := maxTitle * 618 / 1000
	return string(runes[:keep]) + " … " + string(runes[len(runes)-(maxTitle-keep):])
}

func rowOf(e Entry) Row {
	return Row{
		ID:       e.ID,
		SourceID: e.SourceID,
		Feed:     e.Feed,
		URL:      e.URL,
		Date:     dateLabel(e.Published),
		Saved:    e.State == "bookmarked",
		Title:    capTitle(displayTitle(e.Title, e.Text, e.URL)),
	}
}

func gzipped(data []byte) []byte {
	var out bytes.Buffer
	w := gzip.NewWriter(&out)
	w.Write(data)
	w.Close()
	return out.Bytes()
}

func (s *Server) newPage(kind, path, heading string) *Page {
	nav := []NavLink{
		{Href: "/", Label: "Unread"},
		{Href: "/all", Label: "All"},
		{Href: "/archive", Label: "Archive"},
		{Href: "/bookmarks", Label: "Bookmarks"},
		{Href: "/feeds", Label: "Feeds"},
		{Href: "/search", Label: "Search"},
	}
	for i := range nav {
		nav[i].Current = nav[i].Href == path
	}
	return &Page{Kind: kind, Path: path, Heading: heading, Version: s.version, Nav: nav}
}

func (p *Page) setEntries(entries []Entry) {
	p.Rows = make([]Row, len(entries))
	for i, e := range entries {
		p.Rows[i] = rowOf(e)
		p.MaxID = max(p.MaxID, e.ID)
	}
}

// load gathers what a path shows. It returns nil for a path that isn't a page.
func (s *Server) load(path string) (*Page, error) {
	var page *Page
	var sc scope
	switch path {
	case "/":
		page, sc = s.newPage("unread", path, "Unread"), scopeUnread
	case "/all":
		page, sc = s.newPage("list", path, "All"), scopeAll
	case "/archive":
		page, sc = s.newPage("list", path, "Archive"), scopeArchive
	case "/bookmarks":
		page, sc = s.newPage("list", path, "Bookmarks"), scopeBookmarks
	case "/search":
		return s.newPage("search", path, "Search"), nil
	case "/feeds":
		sources, err := s.store.sources()
		if err != nil {
			return nil, err
		}
		page = s.newPage("feeds", path, "Feeds")
		page.Feeds = sources
		return page, nil
	default:
		rest, isFeed := strings.CutPrefix(path, "/feed/")
		id, err := strconv.ParseInt(rest, 10, 64)
		if !isFeed || err != nil {
			return nil, nil
		}
		source, err := s.store.source(id)
		if err != nil {
			return nil, nil
		}
		page, sc = s.newPage("list", path, source.Label), scopeFeed(id)
	}
	entries, err := s.store.entries(sc)
	if err != nil {
		return nil, err
	}
	page.setEntries(entries)
	return page, nil
}

// build renders pages off to the side, then swaps them in together, so a
// request during a build gets the previous complete set.
func (s *Server) build(paths ...string) error {
	s.buildMu.Lock()
	defer s.buildMu.Unlock()
	next := map[string]*builtPage{}
	if current := s.pages.Load(); current != nil {
		for path, page := range *current {
			next[path] = page
		}
	}
	for _, path := range paths {
		page, err := s.load(path)
		if err != nil {
			return err
		}
		if page == nil {
			continue
		}
		var html bytes.Buffer
		if err := s.tmpl.ExecuteTemplate(&html, "page", page); err != nil {
			return err
		}
		sum := sha256.Sum256(html.Bytes())
		next[path] = &builtPage{etag: `"` + hex.EncodeToString(sum[:8]) + `"`, gz: gzipped(html.Bytes())}
	}
	s.pages.Store(&next)
	return nil
}

func feedPath(id int64) string { return "/feed/" + strconv.FormatInt(id, 10) }

// rebuildEntries rebuilds the pages that show entries from these feeds.
func (s *Server) rebuildEntries(feeds ...int64) error {
	paths := []string{"/", "/all", "/archive", "/bookmarks"}
	for _, id := range feeds {
		paths = append(paths, feedPath(id))
	}
	return s.build(paths...)
}

func (s *Server) buildAll() error {
	sources, err := s.store.sources()
	if err != nil {
		return err
	}
	paths := []string{"/", "/all", "/archive", "/bookmarks", "/feeds", "/search"}
	for _, source := range sources {
		paths = append(paths, feedPath(source.ID))
	}
	return s.build(paths...)
}

func writeGzipped(w http.ResponseWriter, r *http.Request, data []byte) {
	if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		w.Write(data)
		return
	}
	reader, err := gzip.NewReader(bytes.NewReader(data))
	if err == nil {
		io.Copy(w, reader)
	}
}

func htmlHeaders(w http.ResponseWriter, cache string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", cache)
}

func (s *Server) serveBuilt(w http.ResponseWriter, r *http.Request, path string) {
	page, ok := (*s.pages.Load())[path]
	if !ok {
		http.NotFound(w, r)
		return
	}
	htmlHeaders(w, "no-cache")
	w.Header().Set("Vary", "Accept-Encoding")
	w.Header().Set("ETag", page.etag)
	if r.Header.Get("If-None-Match") == page.etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	writeGzipped(w, r, page.gz)
}

func (s *Server) servePage(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/" {
		s.fetcher.nudge()
	}
	s.serveBuilt(w, r, r.URL.Path)
}

func (s *Server) search(w http.ResponseWriter, r *http.Request) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	fragment := r.Header.Get("HX-Request") == "true"
	if query == "" && !fragment {
		s.serveBuilt(w, r, "/search")
		return
	}
	page := s.newPage("search", "/search", "Search")
	page.Query = query
	if query != "" {
		entries, err := s.store.searchEntries(query)
		if err != nil {
			serverError(w, err)
			return
		}
		sources, err := s.store.sources()
		if err != nil {
			serverError(w, err)
			return
		}
		page.setEntries(entries)
		page.Feeds = searchFeeds(sources, query)
	}
	htmlHeaders(w, "no-store")
	w.Header().Set("Vary", "HX-Request")
	name := "page"
	if fragment {
		name = "results"
	}
	if err := s.tmpl.ExecuteTemplate(w, name, page); err != nil {
		log.Print(err)
	}
}

func serverError(w http.ResponseWriter, err error) {
	log.Print(err)
	http.Error(w, "server error", http.StatusInternalServerError)
}

func (s *Server) bookmark(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	entry, err := s.store.toggleBookmark(id)
	if err != nil {
		serverError(w, err)
		return
	}
	if err := s.rebuildEntries(entry.SourceID); err != nil {
		serverError(w, err)
		return
	}
	htmlHeaders(w, "no-store")
	current := ""
	if u, err := url.Parse(r.Header.Get("HX-Current-URL")); err == nil {
		current = u.Path
	}
	if current == "/" || (current == "/bookmarks" && entry.State != "bookmarked") {
		return // the row no longer belongs on this page
	}
	if err := s.tmpl.ExecuteTemplate(w, "row", rowOf(entry)); err != nil {
		log.Print(err)
	}
}

func (s *Server) readAll(w http.ResponseWriter, r *http.Request) {
	upto, err := strconv.ParseInt(r.PathValue("upto"), 10, 64)
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	feeds, err := s.store.readAll(upto)
	if err != nil {
		serverError(w, err)
		return
	}
	if err := s.rebuildEntries(feeds...); err != nil {
		serverError(w, err)
		return
	}
	htmlHeaders(w, "no-store")
	io.WriteString(w, "<p>Nothing unread.</p>")
}

// loadAssets compresses the static files once. The version changes when our
// own files do, so browsers can keep them for a long time.
func loadAssets() (map[string]asset, string, error) {
	files := map[string]string{
		"/style.css":      "text/css; charset=utf-8",
		"/js/htmx.min.js": "text/javascript; charset=utf-8",
		"/js/titles.js":   "text/javascript; charset=utf-8",
	}
	assets := map[string]asset{}
	hash := sha256.New()
	for _, path := range []string{"/style.css", "/js/titles.js", "/js/htmx.min.js"} {
		data, err := webFiles.ReadFile("web" + path)
		if err != nil {
			return nil, "", err
		}
		hash.Write(data)
		assets[path] = asset{contentType: files[path], gz: gzipped(data)}
	}
	return assets, hex.EncodeToString(hash.Sum(nil))[:8], nil
}

func serve(store *Store, addresses []string) error {
	tmpl, err := template.ParseFS(webFiles, "web/*.html")
	if err != nil {
		return err
	}
	assets, version, err := loadAssets()
	if err != nil {
		return err
	}
	if removed, err := store.mergeMoved(); err != nil {
		return err
	} else if removed > 0 {
		log.Printf("merged %d copies of moved posts", removed)
	}

	s := &Server{store: store, tmpl: tmpl, version: version}
	s.fetcher = newFetcher(store, func(id int64, added int) {
		err := s.build("/feeds")
		if added > 0 && err == nil {
			err = s.rebuildEntries(id)
		}
		if err != nil {
			log.Print(err)
		}
	})
	if err := s.buildAll(); err != nil {
		return err
	}

	mux := http.NewServeMux()
	for path, file := range assets {
		mux.HandleFunc("GET "+path, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", file.contentType)
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			w.Header().Set("Vary", "Accept-Encoding")
			writeGzipped(w, r, file.gz)
		})
	}
	mux.HandleFunc("GET /search", s.search)
	mux.HandleFunc("POST /bookmark/{id}", s.bookmark)
	mux.HandleFunc("POST /read-all/{upto}", s.readAll)
	mux.HandleFunc("GET /", s.servePage)
	handler := http.NewCrossOriginProtection().Handler(mux)

	if err := s.fetcher.startAll(); err != nil {
		return err
	}
	errs := make(chan error, len(addresses))
	for _, address := range addresses {
		listener, err := net.Listen("tcp", strings.TrimSpace(address))
		if err != nil {
			return err
		}
		log.Printf("listening on http://%s", listener.Addr())
		go func() { errs <- http.Serve(listener, handler) }()
	}
	return <-errs
}
