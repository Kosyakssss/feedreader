# Feedreader

Feedreader is a calm, finite reader for everything that publishes a feed, built to get off social media without losing the people and sites you follow. RSS, Atom and JSON Feed in any form, every feed treated the same, recommendations from friends instead of algorithms. It runs on your own devices: a background server on your Mac, desktop and Android apps that each carry the engine, a web app and a TUI.

The repository is being rewritten from zero as 1.0. [`docs/spec.md`](docs/spec.md) is the source of truth for what to build; this file is how to work on it. Until the rewrite replaces it, the current app in this repository is a reference for behavior only.

## What we never compromise on

### 1. Every feed is equal

Feeds only, no special treatment. A YouTube channel's feed, a podcast feed and a blog are all entries in one list that open the same way. Do not add per-source looks, players, views or plugins. If a feature only makes sense for one platform, it does not belong here.

### 2. Calm and finite

No ranking, no suggestions, no engagement mechanics, no notifications about new items. Lists end. Nothing moves under the reader's cursor.

### 3. Performance without compromise

The look is rich (tactile slabs, depth, springs) and it must still run at the display's refresh rate on ordinary hardware. Find many small optimizations instead of cutting the look. Watch for the usual causes: too much data over the socket, animations that repaint every frame, layout during gestures, lists that render everything. No continuously repainting animations. Budgets live in the performance tooling, so regressions show up as numbers.

### 4. Self-reliant and remote ready

Every app works on its own and syncs when it can reach the hub. Same network, Tailscale and offline are all normal conditions, not edge cases. A feature that only works while connected to the hub on localhost is unfinished.

### 5. Every surface

Desktop, web, Android and the TUI. A feature is done when it works on each of them, or when there is a deliberate decision that it does not apply.

### 6. Open and private

Public repository, no cloud service run by us, no accounts required, no app stores. Nothing personal ever leaves the user's devices except the "I recommend" feed they publish on purpose.

## A note on simplicity

Prefer the smallest model that makes the correct behavior unsurprising. Do not keep complexity because it exists, and do not add machinery because it looks architectural. Measure twice, cut once, and do not build what is not needed yet. When the spec and the simplest design disagree, say so instead of quietly following either.

## Glossary

- **owner** means kote, who decides what Feedreader is. Product decisions come from the spec or from them.
- **engine** means the Effect program that owns user state, fetching, plugins and sync. Every app carries one.
- **hub** means the one engine per setup that holds the authoritative state, serves the web app and the public feed, and is what devices pair with. Normally the Mac's background server.
- **satellite** means an engine on another device that syncs with the hub and fetches feeds on its own only while the hub is unreachable.
- **client** means a UI: desktop, web, Android or TUI.
- **command** means a request to change user state. **change log** means the ordered record of accepted commands.
- **entry** means one item from a feed. **saved link** means a page bookmarked without subscribing.
- **view** means a list (Home, Bookmarks, a folder, a feed). **tab** means an opened entry or page.

## Hit every surface

The most common defect is a change that works on the path you tried and is missing everywhere else. Before calling work done, check which of these apply and say so:

- **Clients.** Desktop (Electron around the web app), web, Android (React Native, its own screens) and the TUI. Shared logic belongs in `packages/client-runtime`, not in one app.
- **Engine roles.** Hub and satellite, online and offline, a satellite reconnecting after days away.
- **Entry points.** Something reachable from a tab is usually also reachable from the list's bulk bar, the command palette, a shortcut and the CLI.
- **Contracts.** Anything crossing the wire is typed in `packages/contracts`. Change the schema and every app follows.
- **Reverse states.** A way in needs a way out and a way to see it: bookmark and unbookmark, pin and unpin, recommend and remove. Every user-visible change is undoable.
- **Connection routes.** Localhost, same network, Tailscale; http and https.
- **Docs.** Check whether the change makes existing guidance wrong.

## Taste

- Complexity belongs at the edges. Command decisions stay pure; the UI stays dumb.
- Engine features are services; transports stay thin. A WebSocket handler, HTTP route or CLI command decodes input, calls one service method and maps errors. The scheduler, plugins and the CLI then reach the same capability.
- Read [`.repos/`](#references) for the libraries' own patterns before inventing one.
- Inferred types over annotations. `any` is the enemy.
- No code comments, of any kind (owner's rule). Names and types carry the meaning; reasons that cross components go in `docs/internals/`.
- Do not invent keyboard shortcuts. Only the ones in the spec are fixed.
- If a rule here fights the task in front of you, say so plainly and get the owner's sign-off before breaking it.

## Verifying

- Tests are laws (spec §5.10): statements about behavior that hold for every input, checked against generated inputs. Never tests that restate the code, assert source strings or check implementation shapes. New laws and new test files need the owner's approval.
- Wait for asynchronous work by draining the worker or awaiting the persisted result, never with sleeps or polling. A test that needs a timeout to pass is wrong.
- Use the smallest proof that the change works: the tests you touched, targeted lint and typecheck. Do not run repo-wide checks unless asked.
- User-visible changes get one pass in a real client. Ask before using browser automation or computer use.

## Repository rules

- The repository is public. Never commit secrets, credentials, personal data, session data or machine-local state. Never hardcode a home path; derive paths at runtime.
- Version control is `jj`. Commit only when asked. Never push, add remotes or rewrite shared history without explicit approval.
- Do not commit plans, research notes or scratch files. Keep them outside the repository.

## Documentation

- `docs/spec.md` holds product, UX and architecture decisions until 1.0 ships; visual design is decided in the real app, not there. When a decision changes, rewrite the affected text; do not append a second account or keep the old one.
- `docs/internals/` is for decisions and their reasons, constraints across components and traps that are hard to see from the source. If reading the code answers the question, leave it out.
- `docs/user/` helps people do things: what a feature does, how to start, anything unintuitive. No descriptions of buttons, layouts or animations.

## References

`.repos/` holds read-only checkouts of upstream projects whose patterns we follow (t3code, Effect, OpenTUI), pinned to the versions we depend on and filled by a sync script (gitignored; set up in the foundation step). Never edit or import from them. For Effect, read its `LLMS.md` before writing engine code.
