package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"strings"
	"time"
)

const usage = `feedreader serve   [--db path] [--listen addr,addr]
feedreader port    --from old.sqlite [--db path]
feedreader entries [--db path] [--unread | --bookmarked]
feedreader add     [--db path] <feed url | @handle | did:...>
feedreader check   [--db path]`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
	var err error
	switch command, args := os.Args[1], os.Args[2:]; command {
	case "serve":
		err = cmdServe(args)
	case "port":
		err = cmdPort(args)
	case "entries":
		err = cmdEntries(args)
	case "add":
		err = cmdAdd(args)
	case "check":
		err = cmdCheck(args)
	default:
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
	if err != nil {
		log.Fatal(err)
	}
}

func dbFlag(fs *flag.FlagSet) *string {
	return fs.String("db", "data/feedreader.sqlite", "database file")
}

func cmdServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	db := dbFlag(fs)
	listen := fs.String("listen", "127.0.0.1:8789", "comma-separated addresses")
	fs.Parse(args)
	store, err := openStore(*db)
	if err != nil {
		return err
	}
	return serve(store, strings.Split(*listen, ","))
}

func cmdPort(args []string) error {
	fs := flag.NewFlagSet("port", flag.ExitOnError)
	db := dbFlag(fs)
	from := fs.String("from", "", "old database")
	fs.Parse(args)
	if *from == "" {
		return fmt.Errorf("port needs --from")
	}
	if _, err := os.Stat(*db); err == nil {
		return fmt.Errorf("%s already exists", *db)
	}
	store, err := openStore(*db)
	if err != nil {
		return err
	}
	return store.port(*from)
}

func cmdEntries(args []string) error {
	fs := flag.NewFlagSet("entries", flag.ExitOnError)
	db := dbFlag(fs)
	unread := fs.Bool("unread", false, "only unread")
	bookmarked := fs.Bool("bookmarked", false, "only bookmarked")
	fs.Parse(args)
	store, err := openStore(*db)
	if err != nil {
		return err
	}
	state := ""
	if *unread {
		state = "unread"
	} else if *bookmarked {
		state = "bookmarked"
	}
	entries, err := store.export(state)
	if err != nil {
		return err
	}
	out := json.NewEncoder(os.Stdout)
	out.SetEscapeHTML(false)
	out.SetIndent("", "  ")
	return out.Encode(entries)
}

func cmdAdd(args []string) error {
	fs := flag.NewFlagSet("add", flag.ExitOnError)
	db := dbFlag(fs)
	fs.Parse(args)
	if fs.NArg() != 1 {
		return fmt.Errorf("add needs one feed")
	}
	store, err := openStore(*db)
	if err != nil {
		return err
	}
	kind, ref, label, err := discover(fs.Arg(0))
	if err != nil {
		return err
	}
	if err := store.addSource(kind, ref, label); err != nil {
		return err
	}
	fmt.Printf("added %s (%s)\n", label, ref)
	return nil
}

// cmdCheck fetches every feed without saving and reports what the parser saw.
// "new" counts items the database does not already hold, so a parser that
// disagrees with what was stored shows up as a large number.
func cmdCheck(args []string) error {
	fs := flag.NewFlagSet("check", flag.ExitOnError)
	db := dbFlag(fs)
	fs.Parse(args)
	store, err := openStore(*db)
	if err != nil {
		return err
	}
	sources, err := store.sources()
	if err != nil {
		return err
	}
	type line struct {
		label, status string
		items, fresh  int
	}
	lines := make([]line, len(sources))
	limit := make(chan struct{}, 8)
	done := make(chan struct{})
	for i, source := range sources {
		go func() {
			limit <- struct{}{}
			defer func() { <-limit; done <- struct{}{} }()
			blank := source
			blank.ETag, blank.LastModified = "", ""
			result := fetchSource(blank)
			l := line{label: source.Label, status: "ok", items: len(result.Items)}
			if result.Error != "" {
				l.status = result.Error
			}
			if known, err := store.knownCount(source.ID, result.Items); err == nil {
				l.fresh = len(result.Items) - known
			}
			lines[i] = l
		}()
	}
	for range sources {
		<-done
	}
	failed, items, fresh := 0, 0, 0
	for _, l := range lines {
		if l.status != "ok" {
			failed++
		}
		items += l.items
		fresh += l.fresh
		fmt.Printf("%-44.44s %4d items %4d new  %s\n", l.label, l.items, l.fresh, l.status)
	}
	fmt.Printf("\n%d feeds, %d failed, %d items, %d new\n", len(lines), failed, items, fresh)
	return nil
}

func dateLabel(ms int64) string {
	t := time.UnixMilli(ms)
	if t.Year() == time.Now().Year() {
		return t.Format("Jan 2")
	}
	return t.Format("Jan 2, 2006")
}
