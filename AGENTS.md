# Feedreader

Feedreader is a calm, finite reader for everything that publishes a feed, built to get off social media without losing the people and sites you follow. RSS, Atom and JSON Feed in any form, every feed treated the same, recommendations from friends instead of algorithms. It is one Rust codebase: Graticule, our own framework for native apps that Feedreader proves; the engine, which owns feeds, state and sync; and the apps that carry the engine.

[`docs/spec.md`](docs/spec.md) is the source of truth for what to build, and its §10 is the build plan with status; this file is how to work on it.

## What we never compromise on

### 1. Every feed is equal

Feeds only, no special treatment. A YouTube channel's feed, a podcast feed and a blog are all entries in one list that open the same way. Do not add per-source looks, players, views or plugins. If a feature only makes sense for one platform, it does not belong here.

### 2. Calm and finite

No ranking, no suggestions, no engagement mechanics, no notifications about new items. Lists end. Nothing moves under the reader's cursor.

### 3. Text first, everything visible

The interface is text, rules and boxes. Every action available right now is on screen, generated from the command registry. Nothing floats, nothing hides behind gestures, state is always visible.

### 4. Performance without compromise

Input to pixels within one display refresh. No render loop: frames are drawn on input, data and resize only, and nothing animates continuously. Budgets live in the profiling tooling, so regressions show up as numbers.

### 5. Self-reliant and remote ready

Every app works on its own and syncs when it can reach the hub. Same network, Tailscale and offline are all normal conditions, not edge cases.

### 6. Open and private

Public repository, no cloud service run by us, no accounts required, no app stores. Nothing personal ever leaves the user's devices except the "I recommend" feed they publish on purpose.

## A note on simplicity

Prefer the smallest model that makes the correct behavior unsurprising. Do not keep complexity because it exists, and do not add machinery because it looks architectural. When the spec and the simplest design disagree, say so instead of quietly following either.

## Glossary

- **owner** means kote, who decides what Feedreader is. Product decisions come from the spec or from them.
- **Graticule** (model DK-01) means `crates/graticule`: the framework (spec §6). The shell, the grid, styles, components, pictures, the canvas, text, the command registry and the gallery. It knows nothing about feeds.
- **engine** means `crates/engine`: the library that owns user state, fetching, the public listener and sync. Every app carries one.
- **hub** means the one engine per setup that holds the authoritative state, serves the public feed, and is what devices pair with. Normally the Mac's background engine.
- **satellite** means an engine on another device that syncs with the hub and fetches feeds on its own only while the hub is unreachable.
- **command** (UI) means an entry in the registry: name, label, keys, availability. **command** (engine) means a request to change user state; **change log** means the ordered record of accepted ones.
- **entry** means one item from a feed. **saved link** means a page bookmarked without subscribing.
- **place** means where a list lives: Home, Bookmarks, I recommend, a folder, a pinned feed, Feeds, Settings. Places are always visible. **tab** means a document you opened: an entry, a page, a player or an empty new tab. Tabs can be many and scroll.
- **web pane** means the system web view placed over the reading area for Original pages, embeds and media.

## Hit every surface

The most common defect is a change that works on the path you tried and is missing everywhere else. Before calling work done, check which of these apply and say so:

- **Apps.** Desktop (macOS, Linux), wide and narrow layouts, the headless `serve` engine and the command line. Android is paused (spec §1.3); don't extend it.
- **Engine roles.** Hub and satellite, online and offline, a satellite reconnecting after days away.
- **Entry points.** An action belongs in the registry, so it shows in the bar, the help page and the palette, and works by mouse. Bulk versions work on the selection. Add a CLI command when scripts need it.
- **Contracts.** `Request`, `Event` and `Command` in the engine crate are the wire format. Change them and every app follows; an incompatible change bumps `engine::PROTOCOL`.
- **Reverse states.** A way in needs a way out and a way to see it: bookmark and unbookmark, pin and unpin, recommend and remove. Every user-visible change is undoable.
- **Connection routes.** Localhost, same network, Tailscale; http and https.
- **Docs.** Check whether the change makes the spec, the README or `docs/` wrong.

## Taste

- Complexity belongs at the edges. Engine decisions are pure functions over state; the view is a pure function of the model.
- Engine features are methods on the engine; transports stay thin. A request handler, HTTP route or CLI command decodes input, calls one engine method and maps errors.
- State is enums, not flags that can contradict each other.
- Inferred types over annotations. No `unsafe` anywhere; the workspace denies it. When a platform API needs it, use a crate that wraps it safely. The only approved exception is the native context menu on macOS, explained in `docs/internals/unsafe.md`; any other one needs the owner's sign-off first, with proof that no safe route exists.
- No code comments, of any kind (owner's rule). Names and types carry the meaning; reasons that cross components go in `docs/internals/`.
- Do not invent keyboard shortcuts. Only the ones in the spec are fixed; new commands are clickable labels until the owner assigns keys.
- If a rule here fights the task in front of you, say so plainly and get the owner's sign-off before breaking it.

## Verifying

- Tests are laws (spec §5.10): properties over generated inputs and operation sequences (proptest), never tests that restate the code. New laws and new test files need the owner's approval.
- Use the smallest proof: `cargo build`, `cargo clippy` on the crates you touched, and the laws you touched.
- Look at the result. `feedreader --snapshot out.png --size WxH --keys "…"` renders any state offscreen and prints paint times; use it at the smallest and largest sizes. `feedreader --gallery` renders every screen in every style and appearance at once. Point `FEEDREADER_HOME` at a copy of the data so the owner's library stays untouched.
- Measure. `cargo run --release --features profile` and Tracy show zones, frames and allocations.
- User-visible changes get one pass in the real window. Ask before using computer use on the owner's screen.

## Repository rules

- The repository is public. Never commit secrets, credentials, personal data, session data or machine-local state. Never hardcode a home path; derive paths at runtime.
- Version control is `jj`. Never add remotes or rewrite shared history without explicit approval.
- Do not commit research notes or scratch files. The build plan lives in the spec.

## Documentation

- `docs/spec.md` holds product, UX and architecture decisions until 1.0 ships. When a decision changes, rewrite the affected text; do not append a second account or keep the old one. Keep §10 current.
- `docs/internals/` is for decisions and their reasons, constraints across components and traps that are hard to see from the source. If reading the code answers the question, leave it out.
- `README.md` says what Feedreader is and how to run, import and profile it.
