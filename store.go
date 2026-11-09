package main

import (
	"database/sql"
	"fmt"
	"net/url"
	"slices"
	"strings"
	"time"
	"unicode"

	_ "github.com/mattn/go-sqlite3"
)

const schema = `
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('rss', 'atproto')),
  ref TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  folder TEXT NOT NULL DEFAULT '',
  etag TEXT NOT NULL DEFAULT '',
  last_modified TEXT NOT NULL DEFAULT '',
  fetched_at INTEGER,
  next_at INTEGER,
  failures INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  guid TEXT NOT NULL,
  url TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('none', 'unread', 'read', 'bookmarked')),
  title TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  body TEXT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS source_guid ON entries(source_id, guid) WHERE guid <> '';
CREATE UNIQUE INDEX IF NOT EXISTS source_url ON entries(source_id, url) WHERE url <> '';
CREATE INDEX IF NOT EXISTS timeline ON entries(published_at DESC, id DESC) WHERE state <> 'none';
CREATE INDEX IF NOT EXISTS by_source ON entries(source_id, published_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS by_state ON entries(state, published_at DESC, id DESC);
`

type Store struct{ db *sql.DB }

func openStore(path string) (*Store, error) {
	db, err := sql.Open("sqlite3", "file:"+path+"?_journal_mode=WAL&_busy_timeout=5000&_foreign_keys=on&_synchronous=NORMAL")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		return nil, err
	}
	return &Store{db}, nil
}

type Source struct {
	ID                 int64
	Kind, Ref, Label   string
	Folder             string
	ETag, LastModified string
	FetchedAt, NextAt  sql.NullInt64
	Failures           int
	Error              string
}

const sourceColumns = `id, kind, ref, label, folder, etag, last_modified, fetched_at, next_at, failures, error`

func scanSource(row interface{ Scan(...any) error }) (s Source, err error) {
	err = row.Scan(&s.ID, &s.Kind, &s.Ref, &s.Label, &s.Folder, &s.ETag, &s.LastModified, &s.FetchedAt, &s.NextAt, &s.Failures, &s.Error)
	return
}

func (st *Store) sources() ([]Source, error) {
	rows, err := st.db.Query(`SELECT ` + sourceColumns + ` FROM sources ORDER BY folder, label COLLATE NOCASE`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Source
	for rows.Next() {
		s, err := scanSource(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func (st *Store) source(id int64) (Source, error) {
	return scanSource(st.db.QueryRow(`SELECT `+sourceColumns+` FROM sources WHERE id = ?`, id))
}

func (st *Store) addSource(kind, ref, label string) error {
	_, err := st.db.Exec(`INSERT INTO sources (kind, ref, label) VALUES (?, ?, ?)`, kind, ref, label)
	return err
}

func (st *Store) lastPost(id int64) int64 {
	var ms sql.NullInt64
	st.db.QueryRow(`SELECT max(published_at) FROM entries WHERE source_id = ?`, id).Scan(&ms)
	return ms.Int64
}

// save stores a fetch and reports how many entries it added or filled in.
func (st *Store) save(source Source, result Result, failures int, nextAt int64) (int, error) {
	now := time.Now().UnixMilli()
	state := "unread"
	if !source.FetchedAt.Valid {
		state = "none" // the first fetch of a feed is its backlog
	}
	identical := len(result.Items) > 3
	if identical {
		for _, item := range result.Items {
			identical = identical && item.Published == result.Items[0].Published
		}
	}
	tx, err := st.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	changed := 0
	current := map[string]bool{}
	for _, item := range result.Items {
		current[item.GUID] = true
	}
	for _, item := range result.Items {
		// Some sites change every item's id when they redeploy. The same title
		// at the same moment in the same feed is the same post, unless the
		// other one is still in this very fetch. Point the row at the new id.
		if item.Title != "" && item.Published != 0 {
			moved, err := movedRow(tx, source.ID, item, current)
			if err != nil {
				return 0, err
			}
			if moved != 0 {
				res, err := tx.Exec(`UPDATE OR IGNORE entries SET guid = ?, url = ? WHERE id = ?`, item.GUID, item.URL, moved)
				if err != nil {
					return 0, err
				}
				n, _ := res.RowsAffected()
				changed += int(n)
				continue
			}
		}
		published := item.Published
		if identical || published <= 631_152_000_000 || published > now+86_400_000 {
			published = now
		}
		res, err := tx.Exec(`INSERT OR IGNORE INTO entries (source_id, guid, url, published_at, state, title, text, body)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, source.ID, item.GUID, item.URL, published, state, item.Title, item.Text, nullable(item.Body))
		if err != nil {
			return 0, err
		}
		n, _ := res.RowsAffected()
		if n == 0 && item.Body != "" {
			res, err = tx.Exec(`UPDATE entries SET body = ?, text = ? WHERE source_id = ? AND (guid = ? OR url = ?) AND body IS NULL`,
				item.Body, item.Text, source.ID, item.GUID, item.URL)
			if err != nil {
				return 0, err
			}
			n, _ = res.RowsAffected()
		}
		changed += int(n)
	}
	etag, modified := result.ETag, result.LastModified
	if result.Error != "" {
		etag, modified = source.ETag, source.LastModified
	}
	if _, err := tx.Exec(`UPDATE sources SET fetched_at = ?, next_at = ?, failures = ?, error = ?, etag = ?, last_modified = ? WHERE id = ?`,
		now, nextAt, failures, result.Error, etag, modified, source.ID); err != nil {
		return 0, err
	}
	return changed, tx.Commit()
}

func movedRow(tx *sql.Tx, sourceID int64, item Item, current map[string]bool) (int64, error) {
	rows, err := tx.Query(`SELECT id, guid FROM entries WHERE source_id = ? AND title = ? AND published_at = ? AND guid <> ?`,
		sourceID, item.Title, item.Published, item.GUID)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var guid string
		if err := rows.Scan(&id, &guid); err != nil {
			return 0, err
		}
		if !current[guid] {
			return id, nil
		}
	}
	return 0, rows.Err()
}

// mergeMoved folds together copies of one post left behind by a site that
// changed its address: same feed, title, date and URL path. The newest copy
// stays and keeps the strongest state any copy had.
func (st *Store) mergeMoved() (int, error) {
	rows, err := st.db.Query(`SELECT e.id, e.url, e.state, e.source_id, e.title, e.published_at FROM entries e
		JOIN (SELECT source_id s, title t, published_at p FROM entries WHERE title <> '' GROUP BY 1, 2, 3 HAVING count(*) > 1) d
		ON e.source_id = d.s AND e.title = d.t AND e.published_at = d.p ORDER BY e.id DESC`)
	if err != nil {
		return 0, err
	}
	type copyOf struct {
		id    int64
		state string
	}
	groups := map[string][]copyOf{}
	for rows.Next() {
		var c copyOf
		var link, title string
		var source, published int64
		if err := rows.Scan(&c.id, &link, &c.state, &source, &title, &published); err != nil {
			rows.Close()
			return 0, err
		}
		path := link
		if u, err := url.Parse(link); err == nil {
			path = u.Path
		}
		key := fmt.Sprint(source, "\x00", title, "\x00", published, "\x00", path)
		groups[key] = append(groups[key], c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	strength := map[string]int{"none": 0, "read": 1, "unread": 2, "bookmarked": 3}
	tx, err := st.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	removed := 0
	for _, copies := range groups {
		state := copies[0].state
		for _, c := range copies[1:] {
			if strength[c.state] > strength[state] {
				state = c.state
			}
			if _, err := tx.Exec(`DELETE FROM entries WHERE id = ?`, c.id); err != nil {
				return 0, err
			}
			removed++
		}
		if _, err := tx.Exec(`UPDATE entries SET state = ? WHERE id = ?`, state, copies[0].id); err != nil {
			return 0, err
		}
	}
	return removed, tx.Commit()
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func (st *Store) knownCount(sourceID int64, items []Item) (int, error) {
	known := 0
	for _, item := range items {
		var one int
		err := st.db.QueryRow(`SELECT 1 FROM entries WHERE source_id = ? AND (guid = ? OR (url <> '' AND url = ?) OR (title <> '' AND title = ? AND published_at = ?)) LIMIT 1`,
			sourceID, item.GUID, item.URL, item.Title, item.Published).Scan(&one)
		if err == nil {
			known++
		} else if err != sql.ErrNoRows {
			return 0, err
		}
	}
	return known, nil
}

// A scope is the set of entries one page shows.
type scope struct {
	where string
	args  []any
	limit int
}

var (
	scopeUnread    = scope{where: `state = 'unread'`}
	scopeAll       = scope{where: `state <> 'none'`, limit: 500}
	scopeArchive   = scope{where: `state <> 'none'`}
	scopeBookmarks = scope{where: `state = 'bookmarked'`}
)

func scopeFeed(id int64) scope { return scope{where: `source_id = ?`, args: []any{id}} }

const searchLimit = 200

type Entry struct {
	ID, SourceID, Published int64
	Feed, URL, State        string
	Title, Text             string
}

// entries returns one page's rows, newest first. Text comes back only for
// untitled entries, the only rows that display it.
func (st *Store) entries(sc scope) ([]Entry, error) {
	inner := `SELECT id, source_id, url, published_at, state, title, text FROM entries WHERE ` + sc.where + ` ORDER BY published_at DESC, id DESC`
	if sc.limit > 0 {
		inner += fmt.Sprintf(` LIMIT %d`, sc.limit)
	}
	return st.readEntries(`SELECT e.id, e.source_id, s.label, e.url, e.published_at, e.state, e.title, CASE WHEN e.title = '' THEN e.text ELSE '' END
		FROM (`+inner+`) e JOIN sources s ON s.id = e.source_id ORDER BY e.published_at DESC, e.id DESC`, sc.args...)
}

func (st *Store) readEntries(query string, args ...any) ([]Entry, error) {
	rows, err := st.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Entry
	for rows.Next() {
		var e Entry
		if err := rows.Scan(&e.ID, &e.SourceID, &e.Feed, &e.URL, &e.Published, &e.State, &e.Title, &e.Text); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func wordsOf(text string) []string {
	return strings.FieldsFunc(strings.ToLower(text), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) })
}

// matchWords reports whether every typed word is among the words of a title.
// The last typed word may still be being typed, so it can match the start of a
// word; exact says it didn't need to.
func matchWords(typed, title []string) (found, exact bool) {
	exact = true
	for i, word := range typed {
		if slices.Contains(title, word) {
			continue
		}
		startsWord := func(w string) bool { return strings.HasPrefix(w, word) }
		if i == len(typed)-1 && slices.ContainsFunc(title, startsWord) {
			exact = false
			continue
		}
		return false, false
	}
	return true, exact
}

// searchEntries finds entries in any state by what their row shows as a title.
// Exact matches come first; within that, newest first.
func (st *Store) searchEntries(q string) ([]Entry, error) {
	typed := wordsOf(q)
	if len(typed) == 0 {
		return nil, nil
	}
	all, err := st.readEntries(`SELECT e.id, e.source_id, s.label, e.url, e.published_at, e.state, e.title, CASE WHEN e.title = '' THEN e.text ELSE '' END
		FROM entries e JOIN sources s ON s.id = e.source_id ORDER BY e.published_at DESC, e.id DESC`)
	if err != nil {
		return nil, err
	}
	var exact, partial []Entry
	for _, e := range all {
		found, isExact := matchWords(typed, wordsOf(displayTitle(e.Title, e.Text, e.URL)))
		if found && isExact {
			exact = append(exact, e)
		} else if found {
			partial = append(partial, e)
		}
	}
	results := append(exact, partial...)
	return results[:min(len(results), searchLimit)], nil
}

// searchFeeds finds feeds by name first, then by address or folder.
func searchFeeds(sources []Source, q string) []Source {
	typed := wordsOf(q)
	if len(typed) == 0 {
		return nil
	}
	var byName, byOther []Source
	for _, source := range sources {
		if found, _ := matchWords(typed, wordsOf(source.Label)); found {
			byName = append(byName, source)
		} else if found, _ := matchWords(typed, wordsOf(source.Ref+" "+source.Folder)); found {
			byOther = append(byOther, source)
		}
	}
	return append(byName, byOther...)
}

// toggleBookmark flips one entry: bookmarked becomes read, anything else bookmarked.
func (st *Store) toggleBookmark(id int64) (Entry, error) {
	if _, err := st.db.Exec(`UPDATE entries SET state = CASE state WHEN 'bookmarked' THEN 'read' ELSE 'bookmarked' END WHERE id = ?`, id); err != nil {
		return Entry{}, err
	}
	var e Entry
	err := st.db.QueryRow(`SELECT e.id, e.source_id, s.label, e.url, e.published_at, e.state, e.title, CASE WHEN e.title = '' THEN e.text ELSE '' END
		FROM entries e JOIN sources s ON s.id = e.source_id WHERE e.id = ?`, id).
		Scan(&e.ID, &e.SourceID, &e.Feed, &e.URL, &e.Published, &e.State, &e.Title, &e.Text)
	return e, err
}

// readAll marks unread entries read up to the newest id the page was showing,
// so anything that arrived after the page loaded stays unread.
func (st *Store) readAll(upto int64) ([]int64, error) {
	rows, err := st.db.Query(`UPDATE entries SET state = 'read' WHERE state = 'unread' AND id <= ? RETURNING source_id`, upto)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	touched := map[int64]bool{}
	var feeds []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		if !touched[id] {
			touched[id] = true
			feeds = append(feeds, id)
		}
	}
	return feeds, rows.Err()
}

type Exported struct {
	ID        int64  `json:"id"`
	Feed      string `json:"feed"`
	Title     string `json:"title"`
	URL       string `json:"url"`
	Published string `json:"published"`
	State     string `json:"state"`
	Text      string `json:"text"`
}

func (st *Store) export(state string) ([]Exported, error) {
	query := `SELECT e.id, s.label, e.title, e.url, e.published_at, e.state, e.text FROM entries e JOIN sources s ON s.id = e.source_id`
	var args []any
	if state != "" {
		query += ` WHERE e.state = ?`
		args = append(args, state)
	}
	rows, err := st.db.Query(query+` ORDER BY e.published_at DESC, e.id DESC`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Exported{}
	for rows.Next() {
		var e Exported
		var ms int64
		if err := rows.Scan(&e.ID, &e.Feed, &e.Title, &e.URL, &ms, &e.State, &e.Text); err != nil {
			return nil, err
		}
		e.Published = time.UnixMilli(ms).UTC().Format(time.RFC3339)
		if e.Title == "" {
			e.Title = displayTitle(e.Title, e.Text, e.URL)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// port copies an old Svelte-rewrite database into this one, once.
func (st *Store) port(from string) error {
	if _, err := st.db.Exec(`ATTACH DATABASE ? AS old`, "file:"+from+"?mode=ro"); err != nil {
		return err
	}
	defer st.db.Exec(`DETACH DATABASE old`)
	tx, err := st.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`INSERT INTO sources (id, kind, ref, label, folder, etag, last_modified, fetched_at, next_at, failures, error)
		SELECT s.id, s.kind, s.ref, s.label, coalesce(f.name, ''), coalesce(s.etag, ''), coalesce(s.last_modified, ''), s.fetched_at, s.next_at, s.failures, coalesce(s.error, '')
		FROM old.sources s LEFT JOIN old.folders f ON f.id = s.folder_id WHERE s.removed_at IS NULL`); err != nil {
		return err
	}
	rows, err := tx.Query(`SELECT e.id, e.source_id, coalesce(e.guid, ''), e.url, e.published_at,
		CASE WHEN e.bookmarked_at IS NOT NULL THEN 'bookmarked' WHEN e.state = 'stream' THEN 'read' ELSE e.state END,
		coalesce(e.title, ''), coalesce(e.text, ''), coalesce(e.body, '')
		FROM old.entries e JOIN sources s ON s.id = e.source_id`)
	if err != nil {
		return err
	}
	type old struct {
		id, source, published        int64
		guid, url, state, title, txt string
		body                         string
	}
	var all []old
	for rows.Next() {
		var e old
		if err := rows.Scan(&e.id, &e.source, &e.guid, &e.url, &e.published, &e.state, &e.title, &e.txt, &e.body); err != nil {
			rows.Close()
			return err
		}
		all = append(all, e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, e := range all {
		text := e.txt
		if e.body != "" {
			text = plain(e.body)
		}
		if _, err := tx.Exec(`INSERT OR IGNORE INTO entries (id, source_id, guid, url, published_at, state, title, text, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			e.id, e.source, e.guid, e.url, e.published, e.state, cleanTitle(e.title, e.url), text, nullable(e.body)); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	fmt.Printf("ported %d entries\n", len(all))
	return nil
}
