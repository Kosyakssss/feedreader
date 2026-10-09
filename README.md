# Feedreader

A calm, finite reader for everything that publishes a feed: RSS, Atom and JSON Feed, every feed treated the same, recommendations from friends instead of algorithms. Native and text-first, written in Rust, running on your own devices.

- Home, Bookmarks, folders and pinned feeds; mute words and duplicate links globally, per folder or per feed.
- Read any entry as a clean extracted article, the feed's own text, or the original page.
- An "I recommend" feed: recommend entries with a note, and friends follow one public link in any feed reader.
- Every action is on screen, every change is undoable, nothing moves on its own.

The plan and the decisions behind it are in [`docs/spec.md`](docs/spec.md).

## Run it

Install [Rust](https://rustup.rs), then from the repository:

```sh
cargo run --release
```

Data lives in `~/Library/Application Support/Feedreader` on macOS and `$XDG_DATA_HOME/Feedreader` on Linux. Set `FEEDREADER_HOME` to use another folder.

Press `?` for every command and its keys. `1`–`4` switch between Home, Bookmarks, Feeds and Settings, `j`/`k` move, `o` opens, `m` and `s` toggle read and bookmark, `x` selects, `r` refreshes.

## Bring your feeds

Drop an OPML file, or the old Feedreader's `feedreader.sqlite`, on the window, or:

```sh
feedreader import ~/Downloads/subscriptions.opml
```

## Command line

The app binary is also the command:

```sh
feedreader refresh            # fetch every feed now and report failures
feedreader unread --limit 20  # unread entries as a Markdown list
feedreader import <file>      # OPML or the old app's database
feedreader extract <url>      # the clean article text of any page
```

## Profile it

Feedreader is instrumented for [Tracy](https://github.com/wolfpld/tracy). Start Tracy, then:

```sh
cargo run --release --features profile
```

Frames, zones in the view, text and GPU code, and the engine's work show up live. For a quick look without Tracy, the status line shows the paint and GPU time of the last frame and the worst recent one, and `feedreader --snapshot out.png --keys "3 j j"` renders a state offscreen and prints its paint time.
