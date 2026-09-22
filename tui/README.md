# Feedreader TUI

A Ratatui client for an already running Feedreader server. It uses the same HTTP API as the web UI and does not read the server's database or configuration files.

From the repository root:

```sh
bun run tui
```

The default server is `http://127.0.0.1:8787/feedreader`. Set `FEEDREADER_URL` or pass `--server URL` to connect elsewhere. For example:

```sh
bun run tui --server http://127.0.0.1:8787/feedreader
```

Run `cargo run --manifest-path tui/Cargo.toml --release -- --check` to verify the server connection without opening the terminal UI.

The terminal supplies the background and ordinary text colors. The TUI uses Flexoki accents and detects macOS light or dark appearance. Use `--light` or `--dark` when the terminal appearance differs from the system setting.

Press `?` for all shortcuts. Use `1`–`4` for Timeline, Starred, Feeds, and Settings. Entry navigation uses `j`/`k`; `o` opens a link in the default browser, `m` changes read state, `s` changes starred state, and `x` selects entries. `h`/`l` changes the entry filter. Mouse clicks, hovering, scrolling, and selection dragging are supported. `q` quits.

Feed import and export prompts take a file path. Export refuses to overwrite an existing file. The server continues to own refreshes and all saved state.
