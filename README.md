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
cargo run -p bindery -- install -p feedreader   # builds Feedreader.app into ~/Applications and links ~/.local/bin/feedreader
```

or, without installing anything, `cargo run --release` (run `cargo run -p bindery -- fonts` once first so Chinese, Japanese and Korean paint in Plex). Bindery (BD-01) is Graticule's packager; `cargo install --path crates/bindery` puts it on your path, and then `bindery list`, `bindery check` and `bindery update` keep installed apps current (`bindery service install` checks once a day, quietly).

## Graticule's tools

```sh
cargo run -p graticule --bin specimen            # SP-01 Specimen: every component in every state
cargo run -p graticule --bin specimen -- --out target/specimen   # the same, as a page of images
GRATICULE_SCOPE=1 cargo run --release            # SC-01 Scope over Feedreader, also under View in the menu bar
cargo run -p bindery -- dev -p graticule         # Specimen, rebuilt and reloaded in place on every saved change
cargo run -p bindery -- dev -- --in-process      # the same for Feedreader, with the engine in the app so engine changes reload too
```

Pictures in `crates/graticule/pictures` are compiled at build time by EN-01 Engraver (`crates/engraver`).

Data lives in `~/Library/Application Support/Feedreader` on macOS and `$XDG_DATA_HOME/Feedreader` on Linux. Set `FEEDREADER_HOME` to use another folder.

Press `?` for every command and its keys. `1`–`4` switch between Home, Bookmarks, Feeds and Settings, `j`/`k` move, `o` opens, `m` and `s` toggle read and bookmark, `x` selects, `r` refreshes.

## Bring your feeds

Drop an OPML file, or the old Feedreader's `feedreader.sqlite`, on the window, or:

```sh
feedreader import ~/Downloads/subscriptions.opml
```

## The engine keeps running

Feedreader's engine refreshes feeds and serves your public "I recommend" feed in the background, and the app attaches to it. To start it at login and keep it running after you quit the app:

```sh
feedreader service install    # launchd on macOS, systemd on Linux
feedreader service uninstall
```

"Quit completely" and "restart engine" are in Settings.

## Use it on more than one device

The first Feedreader you set up is the hub. To sync another device with it, choose "Sync another device with this one" in the hub's Settings (or run `feedreader pair` there) and open the link, or scan the code, on the other device: "Sync this device with a hub" in its Settings, or `feedreader pair '<link>'`. Devices reach the hub on the same network or over Tailscale, keep working on their own while they can't, and catch up when they can.

If the macOS firewall is on, allow the hub to accept connections, or only the same Mac can reach it:

```sh
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add ~/.local/bin/feedreader --unblockapp ~/.local/bin/feedreader
```

## Command line

The app binary is also the command:

```sh
feedreader refresh            # fetch every feed now and report failures
feedreader unread --limit 20  # unread entries as a Markdown list
feedreader import <file>      # OPML or the old app's database
feedreader export <file>      # OPML with folders
feedreader extract <url>      # the clean article text of any page
feedreader pair [link]        # show a pairing link, or pair with one
```

## Profile it

Feedreader is instrumented for [Tracy](https://github.com/wolfpld/tracy). Start Tracy, then:

```sh
cargo run --release --features profile
```

Frames, zones in the view, text and GPU code, and the engine's work show up live. For a quick look without Tracy, the status line shows the paint and GPU time of the last frame and the worst recent one, and `feedreader --snapshot out.png --keys "3 j j"` renders a state offscreen and prints its paint time. `feedreader --gallery` renders every screen in every line style, light and dark, wide and narrow, into `target/gallery/index.html`.
