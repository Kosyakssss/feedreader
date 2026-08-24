# Feedreader UI and interaction system

Status: living product specification. This document defines what the interface must feel like and how it must behave. It deliberately does not prescribe an implementation technology.

### Scope and completeness

This specification is exhaustive relative to:

- the current Feedreader routes, controls, shortcuts, and backend-visible states;
- the agreed interaction direction, including the refresh-progress concept;
- known data conditions and failure modes;
- regular and compact web layouts;
- the explicit future extension points listed here.

It cannot be exhaustive relative to every feature someone might imagine later. A feature is not part of the product merely because a generic design system could contain it. New product scope must first be added to the information architecture, then to the component and interaction inventories.

Where a visual choice has not yet been made, this document records it under **Decisions still open** instead of disguising a guess as a requirement. Everything outside that register is normative unless marked as a future extension.

## 1. Product model

Feedreader is a fast, local-first launcher for feeds. It helps a person scan what is new, decide what matters, and open the original source. It is not an in-app reading environment.

The interface should feel:

- calm while idle;
- immediate under direct manipulation;
- dense without becoming cramped;
- quiet about routine success and explicit about failure;
- equally deliberate with mouse, keyboard, and touch;
- native to the available space rather than like a desktop page squeezed onto a phone.

The backend is authoritative. The UI should expose its state clearly without making persistence, polling, or feed parsing feel like concepts the user must manage.

## 2. Design principles

### 2.1 Content before chrome

Entry titles, source names, and recency are the main interface. Navigation and controls should recede until they are relevant. Decorative UI must not reduce the number of useful entries visible on screen.

### 2.2 One component, one contract

A repeated pattern must be a real component with one anatomy, state model, interaction contract, and accessibility contract. Pages may compose or configure components; they must not create slightly different local versions.

### 2.3 State must be visible

Loading, refreshing, selected, focused, read, starred, saving, empty, partially failed, and failed are different states. They need distinct but restrained treatment. Color alone must never carry the distinction.

### 2.4 Motion explains change

Animation is allowed only when it does at least one of these jobs:

1. preserve spatial continuity;
2. show progress over time;
3. acknowledge direct manipulation;
4. explain where a temporary surface came from or went;
5. confirm that an important state change completed.

If motion does not answer “what changed?” or “where did it go?”, omit it.

### 2.5 Fast paths stay fast

Opening an entry, marking it read, starring it, navigating with `j`/`k`, and selecting several entries are primary actions. Their visible response must occur in the same frame as the input. Persistence may finish afterward.

### 2.6 Progressive disclosure

The default interface shows only common actions. Detail, diagnostics, keyboard help, destructive confirmation, and advanced settings appear on demand.

### 2.7 Platform-respectful behavior

Preserve browser and operating-system conventions:

- real links retain open-in-new-tab, copy-link, modifier-click, and context-menu behavior;
- Back and Forward restore route and sensible scroll state;
- focus is never removed without being placed somewhere appropriate;
- system light/dark preference and reduced-motion preference are honored;
- safe areas, text scaling, zoom, and native scrolling work;
- touch-only devices never depend on hover.

### 2.8 Restraint is part of the identity

No ornamental gradients, glass everywhere, bouncing controls, constant shimmer, or animation merely because a value changed. Blur and shadow are reserved for floating layers. Rounded capsules are reserved for elements whose shape carries meaning, such as progress and compact status; the entire application must not become a collection of pills.

## 3. Information architecture

### 3.1 Persistent destinations

| Destination | Purpose | Primary content |
| --- | --- | --- |
| Timeline | Scan all entries, newest first | Filtered entry list and timeline actions |
| Starred | Return to saved entries | Starred entry list |
| Feeds | Manage subscriptions and inspect feed health | Add/import/export controls and feed list |
| Feed detail | Scan one source | Feed title, filters, actions, and entry list |
| Settings | Change operational limits | Settings form |

Unknown application routes should show a small not-found state with a route back to Timeline. They must not silently resemble a valid Timeline navigation.

### 3.2 Persistent app shell

The shell contains:

1. product link;
2. refresh status region;
3. primary navigation on regular widths;
4. compact navigation trigger and menu on narrow widths;
5. page content;
6. global temporary layers: selection bar, dialogs, popovers, and toasts.

The top bar is sticky. It stays visually stable during navigation and refresh. Page content may change; the shell must not flash or re-enter.

### 3.3 Browser surface

Browser-visible metadata is part of the interface:

- Timeline: `Feedreader`;
- Starred: `Starred — Feedreader`;
- Feed detail: `<feed name> — Feedreader`;
- Feeds: `Feeds — Feedreader`;
- Settings: `Settings — Feedreader`;
- not found: `Not found — Feedreader`.

The product icon is stable across routes. The document title does not animate or show transient refresh progress. An unread-count prefix is intentionally omitted until its notification value is explicitly decided; the in-app counts remain authoritative.

### 3.4 Product state vocabulary

| Domain | States that the UI must represent |
| --- | --- |
| Initial data | loading, loaded-empty, loaded-with-content, failed |
| Refresh run | idle, starting, running, complete, partially failed, failed |
| Entry | unread/read, unstarred/starred, unselected/selected, keyboard-focused, mutation-pending, unsafe/missing link |
| Feed | never checked, healthy with items, healthy with zero items, failed |
| Collection | all/unread/read filter, first 50/more available/fully shown, new items waiting above |
| Mutation | idle, optimistic pending, saved, rolled back |
| Overlay | closed/open/closing, with trigger and return-focus target |
| Navigation | current destination, inactive destination, compact menu open/closed |
| Connectivity | connected, reconnecting, unreachable, restored |
| External data | current, revalidating, changed elsewhere, reconciled |

## 4. Foundations

### 4.1 Color

The visual base is Flexoki: warm paper in light appearance and a warm near-black in dark appearance. Components consume semantic roles, never raw palette names.

| Role | Light | Dark | Use |
| --- | --- | --- | --- |
| Canvas | `#fffcf0` | `#100f0f` | Page background |
| Surface | `#f2f0e5` | `#1c1b1a` | Rows, panels, controls |
| Surface hover | `#e6e4d9` | `#282726` | Pointer hover and keyboard roving focus |
| Text | `#282726` | `#cecdc3` | Primary text |
| Muted text | `#6f6e69` | `#9f9d96` | Metadata and secondary labels |
| Link/accent | `#205ea6` | `#4385be` | Links, active states, selection, progress |
| Accent strong | `#1a4f8a` | `#67a0ca` | Accent hover/press |
| Accent soft | 10% accent | 18% accent | Selected and active backgrounds |
| Border | 16% text | 17% light text | Hairlines and control boundaries |
| Star | `#bc5215` | `#da702c` | Starred state only |
| Success | `#66800b` | `#879a39` | Healthy completion |
| Warning | `#ad8301` | `#d0a215` | Partial completion and caution |
| Danger | `#af3029` | `#d14d41` | Failure and destructive actions |
| Focus ring | 25% accent | 32% accent | Keyboard focus halo |
| Scrim | 34% text | 72% canvas | Modal/menu backdrop |

Rules:

- Meet WCAG AA contrast for all text and meaningful icons.
- Read state may reduce emphasis, but body text must remain comfortably readable. Do not use opacity below roughly 60% for the entire row.
- Selected state overrides read de-emphasis.
- Star, warning, danger, and success are not interchangeable accent colors.
- Refresh progress uses accent while active. Success color appears only at completion, not during ordinary work.
- Every semantic color state also has a label, icon, weight, shape, or position cue.

### 4.2 Typography

Use the system UI family and the system monospace family for key hints.

| Role | Target | Notes |
| --- | --- | --- |
| Page title | 20px / 1.25, 700 | Compact, not editorial |
| Product title | 16px / 1.2, 600 | Stable in top bar |
| Entry title | 14–15px / 1.4, 500 | 600 when unread |
| Body/control | 15px / 1.5, 500 as needed | Main UI scale |
| Metadata | 12–13px / 1.35 | Must remain legible |
| Status | 12px / 1.2, tabular numerals | Refresh counts and timestamps |
| Key hint | 12px monospace | Shortcut dialog and tooltips |

Use sentence case. Keep negative tracking subtle and limited to larger or heavier text. Numeric progress and counts use tabular numerals. Form fields are at least 16px on compact touch layouts so focusing a field does not trigger viewport zoom.

### 4.3 Spacing and density

The base spatial steps are 4, 8, 12, 16, 24, and 32px.

- The main content column is at most 720px wide.
- Regular page padding is 16px; compact page padding is 8–12px.
- Entry rows target 48–56px depending on metadata wrapping.
- Desktop controls may look 30–34px tall. Their focus and pointer hit region must remain clear.
- Touch targets are at least 44×44px, including icon buttons and compact navigation.
- Related controls use 4–8px gaps. Sections use 16–24px gaps.
- Dense lists use shared borders rather than a separate floating card around every row.

### 4.4 Shape, border, and elevation

- The base visual language is square or nearly square.
- Rows use hairline boundaries and read as one continuous list.
- Inputs and ordinary buttons may use a subtle radius, applied consistently.
- Progress segments, tiny status dots, and compact badges may be capsules.
- Only floating menus, dialogs, tooltips, toasts, and the selection bar receive elevation.
- Prefer a border over a shadow for static surfaces.
- Blur may support the sticky bar and modal scrim, but content must remain legible without blur support.

### 4.5 Icons

Use one coherent icon family with consistent stroke weight, optical size, and alignment. Do not mix emoji, text glyphs, and unrelated icon sets in production controls.

- Icons never replace an ambiguous label without a tooltip and accessible name.
- Common meanings stay stable: star, read/unread, refresh, external link, close, menu, warning, and delete.
- Active icons may fill or change weight; inactive icons remain outlined.
- Icon-only controls have a minimum 44px touch target on compact layouts.

The bookmark product mark may remain conceptually, but its final rendered asset must match the icon system rather than depend on platform emoji rendering.

### 4.6 Layering

From lowest to highest:

1. canvas and page content;
2. sticky top bar;
3. non-modal popovers and compact navigation;
4. selection action bar and toasts;
5. modal scrim and dialog.

A new component must use one of these layers. Arbitrary local stacking values are not allowed.

## 5. Interaction states shared by controls

Every interactive component must define these states where applicable:

| State | Required treatment |
| --- | --- |
| Rest | Clear affordance without demanding attention |
| Hover | Small color/surface change on hover-capable pointers only |
| Active/pressed | Immediate, subtle compression or tone change |
| Focus visible | High-contrast ring independent of hover |
| Disabled | Lower emphasis, no pointer affordance, reason available when non-obvious |
| Loading/pending | Preserve width; disable duplicate submission; show local progress |
| Selected/current | Persistent accent treatment and semantic state |
| Success | Brief confirmation only when the result is not otherwise obvious |
| Warning | Explain partial or recoverable trouble |
| Error | Keep the failed context visible and provide recovery |

Hover, keyboard focus, and selection are separate concepts. They may share a background family but must remain distinguishable when combined.

## 6. Motion system

### 6.1 Timing

| Token | Duration | Use |
| --- | --- | --- |
| Instant | 0ms | Filters, bulk state updates, keyboard/input focus, and changes where animation would delay work |
| Press | 80ms | Button and checkbox depression |
| Fast | 120ms | Hover, icon state, local color/opacity change |
| Standard | 180ms | Menu, popover, row removal, selection bar |
| Deliberate | 240–320ms | Refresh segment expansion/collapse and dialog entrance |

Use a smooth decelerating curve for entrances and state changes, and a slightly faster accelerating curve for exits. No bounce or overshoot in routine UI. A physical spring is acceptable only for direct manipulation and only if it settles once without wobble.

### 6.2 Performance rules

- Animate transform, opacity, color, and clipping where possible.
- Do not animate large-area blur, page height, or dozens of independent rows at once.
- Refresh segments change only at confirmed quartile thresholds. A segment is always entirely empty or entirely full.
- Input acknowledgment must not wait on network work.
- Animation must remain smooth on mobile while a refresh is parsing and inserting entries.
- Layout shift is a defect unless the user directly caused the layout change.

### 6.3 Reduced motion

With reduced motion enabled:

- state changes remain immediate;
- progress still changes quantitatively;
- menus, dialogs, and toasts use a short opacity change or no transition;
- rows do not slide or scale;
- the refresh indicator switches between expanded and collapsed geometry without traveling elements.

Nothing may depend on motion alone to communicate meaning.

### 6.4 Motion decisions by interaction

| Interaction | Motion |
| --- | --- |
| Navigation between primary pages | No whole-page theatrical transition; shell stays fixed and content changes immediately |
| Compact navigation open/close | Fade plus short translation from its trigger |
| Button press | Subtle 1–2% compression, then immediate recovery |
| Star/read toggle | Fast icon/tone transition; no bounce |
| Single row removed by active filter | Short fade and collapse so the result is understandable |
| Many rows removed by bulk action | Update as a group without animating every row |
| Selection bar appears | Translate from the nearest bottom edge with opacity |
| Dialog/popover | Short origin-aware entrance and faster exit |
| Toast | Short upward fade; no scale overshoot |
| New refresh entries | Reveal at their actual sorted positions; preserve the reading position for insertions above the viewport |
| Empty state becomes populated | Content appears as a group; no staggered parade |

## 7. Primitive components

### 7.1 App surface and page container

The app surface owns appearance, text rendering, safe-area insets, and the minimum viewport height. The page container owns readable width and responsive horizontal padding. Individual pages do not redefine either.

### 7.2 Text link

Variants: navigation, entry title, feed title, quiet metadata link, and external action.

- Entry links open the original source in a new tab by product default.
- Modifier-click, middle-click, context menu, copy link, and keyboard activation remain native.
- External-link meaning is conveyed in text or with a consistent icon when needed.
- Missing or unsafe links render as text, not as a broken interactive control.

### 7.3 Button

Variants:

- primary: one main submission within a local form;
- secondary: routine actions;
- quiet: low-emphasis toolbar action;
- danger: confirmed destructive action;
- icon-only: compact row action;
- file action: a button appearance backed by a file chooser.

Rules:

- A button label must not change width dramatically while pending. Reserve space or pair the label with a small progress mark.
- Disabled controls are not used as unexplained status displays.
- Destructive styling appears at the point of confirmation, not on every passive delete affordance.

### 7.4 Icon button

An icon button contains one icon, an accessible name, and a tooltip on hover/focus. Selected icon buttons expose pressed state. Row icon buttons keep their hit areas separated even when their visible glyphs are close.

### 7.5 Segmented filter

The All / Unread / Read control is one component.

- Each segment includes its live count.
- Switching is immediate and does not navigate.
- The selected segment has more than a color-only distinction.
- Counts update optimistically with entry mutations.
- Compact layouts give all three segments equal width.
- Arrow-key navigation between segments is supported when focus is inside the control.

### 7.6 Checkbox and selection lane

The entry checkbox is the explicit selection affordance. The surrounding selection lane enlarges its hit target without making the whole row select on click.

- Tap/click toggles one entry.
- Shift-click selects or deselects the contiguous visible range from the last anchor.
- A stationary press completes the browser's ordinary checkbox click sequence and toggles exactly once; it is never captured or rerendered on pointer-down.
- Fine-pointer drag begins only after 6px of deliberate movement in the lane, then paints one selection state across rows.
- Touch keeps native tap and vertical-scroll behavior. Touch drag does not enter selection-paint mode without a future explicit selection mode.
- The compact selection label provides a 44×44px native hit surface around the unchanged visible checkbox without shifting row content.
- Dragging outside the lane after capture may continue across rows; ordinary scrolling or text selection elsewhere must not start selection.
- Checked, unchecked, pressed, focus-visible, and mixed bulk states have complete visuals.

### 7.7 Text and number fields

Fields have a visible label whenever the purpose is not self-evident from adjacent context. Placeholder text is an example, not the only label.

States: rest, hover, focus, disabled, pending, invalid, and valid-after-submit. Validation appears beside the field and is associated with it programmatically. Values are never cleared after a failed submission.

### 7.8 Badge and status label

Variants: unread count, healthy, warning, failure, and neutral metadata.

- Badges remain secondary to the feed title.
- Long diagnostic text belongs in a tooltip, popover, or detail line rather than a badge.
- Zero-value unread badges are omitted.
- Status labels use stable width where changing values would otherwise cause jitter.

### 7.9 Tooltip

Tooltips explain icons and truncated diagnostics. They appear after a short hover delay and immediately on keyboard focus, remain while hovered, fit inside the viewport, and dismiss on Escape. They never contain required actions.

### 7.10 Popover

Popovers contain optional detail or compact navigation. They are anchored to a trigger, keep focus within sensible boundaries, dismiss on outside press and Escape, and return focus to the trigger. They must not be used for destructive confirmation.

### 7.11 Dialog and confirmation dialog

Dialogs own a title, optional description, explicit actions, focus containment, Escape behavior, and return focus. Destructive confirmation names the object and the consequence. Focus defaults to the safe action unless the destructive action is clearly the expected continuation.

### 7.12 Toast

Toasts report brief outcomes that do not require action. They do not replace inline validation or persistent failure UI.

- Default lifetime: about 2.5–4 seconds based on message length.
- Multiple toasts stack without covering current controls.
- On compact screens they sit above the selection bar and safe area.
- Errors that need recovery remain visible elsewhere after the toast disappears.
- Routine state toggles do not produce toasts because the changed control is sufficient feedback.

### 7.13 Empty, loading, and error state

These share one layout component with optional title, explanation, and action.

- Initial loading says “Loading saved entries…” and does not pretend a refresh is required.
- Empty Timeline distinguishes “no feeds” from “feeds have no entries” and from “this filter has no entries.”
- Empty Starred explains how to star an entry.
- A page-level load failure offers Retry and preserves the shell.
- Skeletons are used only when the expected structure is known and the delay is long enough to justify them. Do not flash skeletons for fast local loads.

### 7.14 Keyboard hint

Displays one key or chord with a consistent monospace treatment. It is informational and never the only label for an action.

## 8. Composite components

### 8.1 Top bar

Anatomy:

1. product mark and “Feedreader” link;
2. flexible spacer;
3. refresh indicator and textual status;
4. primary navigation or compact menu trigger.

The refresh region must not push navigation around as numbers change. Reserve a predictable status width on regular layouts and prioritize the graphic over the long label on compact layouts.

### 8.2 Refresh progress indicator

This is the signature micro-interaction.

#### Anatomy

- four equal capsule tracks;
- each track switches as one whole unit between empty and full;
- an adjacent textual status on widths that allow it;
- a separate accessible live-region message;
- a detail disclosure for failed feeds when failures exist.

Four segments are the default. They represent quartiles of total feed work, not four specific feeds.

At regular width, each track is approximately 18×4px with a 4px gap. At compact width, each is approximately 28×4px so both running and collapsed states remain legible at phone scale. The entire hit region stays aligned to the navigation end, immediately before the compact menu trigger. Tracks and fills use a full capsule radius; fills originate at the inline start so direction follows the document language.

#### Progress mapping

For confirmed progress `p = completed / total`, the number of filled segments is `floor(p × 4)`, clamped to `0…4`. Completion always fills all four. Every confirmed segment is binary: it is either entirely empty or entirely filled. The one active segment may use a transient dark scan from inline start to end to show current work; that scan is motion, not fractional feed progress. At confirmation, the same fill layer stays present and recolors in place, so no empty frame appears between scan and result. Use tabular `completed/total` text when displayed. A feed completion that crosses a quartile advances the graphic immediately. Newly delivered entries may update the list independently.

#### State machine

| State | Graphic | Copy | Behavior |
| --- | --- | --- | --- |
| Saved data loading | One neutral capsule | Loading saved entries… | No fake progress |
| Idle before refresh | One quiet collapsed capsule | Nothing, or last result on demand | Does not animate |
| Starting | Capsule unfolds into four empty tracks | Starting refresh… | 180–240ms expansion |
| Running | Confirmed tracks are full; the next track carries one dark start-to-end scan | Checking feeds `n/total` · `x new` | No fractional progress mapping and no layer reset between scan and confirmation |
| Complete, no new items | Four full accent tracks become success, settle, then merge into one | Up to date | Hold full state briefly before collapse |
| Complete with new items | Same completion, with a restrained count emphasis | `x new` | Count remains visible long enough to read |
| Partially failed | Completed graphic resolves to warning rather than success | Checked · `n` failed, optionally preceded by `x new` | Detail lists failed feed names and errors |
| Failed run | Tracks stop and resolve to danger | Refresh failed | Keep failure visible until acknowledged or a successful retry |
| No subscriptions | One quiet collapsed capsule | No feeds to refresh | Do not expand into four fake-progress tracks |

#### Expansion and collapse

On refresh, the idle capsule expands from its center and separates into four tracks while the fills reset to zero. On successful completion:

1. the final segment reaches full;
2. all four hold for roughly 300ms;
3. gaps close and the four fills visually merge toward the center;
4. the result becomes one quiet capsule;
5. the textual result remains for roughly 2.5 seconds, then recedes unless it contains a warning or failure.

The collapse is one coordinated transformation, not four bars popping out independently. Starting a new refresh during the result hold reverses from the current geometry without flashing idle.

#### Color and failure

- Empty tracks use the border/quiet-surface role.
- Active fill uses accent.
- Full success may pass briefly through success before returning to a quiet idle treatment.
- Partial failure uses warning only after work completes; it does not make completed progress look undone.
- Total failure uses danger and never loops indefinitely.

The running new-entry count is provisional. If final retention removes newly streamed entries, the completion copy and list reconcile to the retained result without counting removed entries as new. If the entire refresh fails after provisional entries were shown, those entries are removed as one rollback, selection is cleaned up, focus moves to the nearest surviving row, and the failure remains visible. The interface must never leave provisional entries behind after the backend has rejected the run.

#### Accessibility

- Expose progressbar semantics with current and maximum values while running.
- Announce start, meaningful milestones at a throttled rate, new-item count changes, and the final result. Do not announce every feed in rapid succession.
- The visual bars are hidden from the accessibility tree when equivalent progress semantics are present.
- Reduced motion uses direct geometry changes while keeping quantitative progress.
- The failure detail trigger is keyboard reachable and has an explicit accessible name.

### 8.3 Navigation

Regular layout shows four destination links. Current location uses both semantic current-page state and a visual treatment.

Feed detail is a child destination of Feeds, so the Feeds navigation item remains current while viewing one feed.

Compact layout uses a menu trigger anchored in the top bar and a lightweight menu surface. Opening it adds a scrim, but the menu remains visually connected to the trigger rather than behaving like a full-screen modal. Selecting a destination, pressing Escape, pressing the scrim, or navigating Back closes it. Focus returns to the trigger when dismissed without navigation.

### 8.4 Timeline toolbar

Contains:

- All / Unread / Read segmented filter;
- Open all unread;
- Mark all read;
- Refresh.

The filter is primary and stays first. Actions may wrap as a group on compact layouts. The explicit Refresh action remains available even though the top bar shows refresh progress.

During refresh, Refresh preserves its width, becomes pending, and prevents duplicate requests. Other timeline actions remain usable. Mark all read and Open all unread are disabled when the current scope contains no unread entries. Open all unread explains the configured cap before opening an excessive number of tabs.

On Feed detail, the refresh label is “Refresh all feeds” because the operation is global. It must not appear to refresh only the displayed source.

### 8.5 Entry list

The list renders newest first and initially exposes 50 rows. “Show more” adds the next 50 and states the remaining count.

Responsibilities:

- preserve scroll position through state changes;
- expose one roving keyboard focus row;
- preserve roving focus by entry ID rather than array index when refresh or sorting changes row positions;
- reconcile optimistic updates without rebuilding unchanged rows;
- show filter-specific empty states;
- keep selection when local row state changes, but clear selection on route change;
- avoid moving the viewport when refreshed entries arrive above the current position.
- remove IDs pruned by retention or refresh rollback from selection and keyboard focus;
- update counts, empty state, and Show more after server-directed removals;
- preserve the nearest surviving scroll anchor when rows are removed above the viewport.

Every retained new entry appears at its actual sorted position, including between existing rows when a feed reports unusual dates. Visible new rows reveal from top to bottom with a short downward expansion/fade; existing visible rows use positional continuity so the insertion is understandable. Insertions above the viewport compensate scroll to hold the reader's visual position. Offscreen rows do not animate, and background refresh never yanks the page upward.

### 8.6 Entry row

Anatomy, left to right:

1. selection lane and checkbox;
2. title and metadata stack;
3. star action;
4. read/unread action.

Metadata is `source · relative time`. Long titles and source names truncate on one line at regular density. The full title remains available to assistive technology and may be exposed in a tooltip when visibly truncated.

Fallback content is stable: missing titles display “Untitled”, missing feed labels display “Unknown source”, and missing or invalid dates display “Unknown date”. Feed-provided text is treated as plain, untrusted text. Directionally unusual text must not reorder adjacent controls or metadata. Future timestamps use an absolute localized date once they are far enough ahead that “just now” would be false.

#### Row state precedence

1. disabled/invalid link affects only the link;
2. selected provides the strongest row surface and leading selection cue;
3. keyboard focus adds a distinct focus cue without erasing selection;
4. unread uses stronger title weight;
5. read reduces emphasis but not legibility;
6. hover is the weakest temporary treatment.

#### Row interactions

- Activating the title opens the original page and marks the entry read optimistically.
- Star toggles without opening the entry.
- Read toggles without opening the entry.
- Checkbox interaction follows the selection contract.
- The rest of the row is not secretly clickable.
- Text remains selectable outside the explicit drag-selection lane.
- On filtered views, a toggle that makes the row no longer match gets a short single-row removal. Keyboard focus advances to the nearest surviving row.
- A failed optimistic mutation restores the previous visual state and reports the failure.

### 8.7 Bulk selection bar

Appears only when at least one entry is selected.

Anatomy:

- selected count;
- Mark read;
- Mark unread;
- Open;
- Star or Unstar, based on the current selection;
- Cancel.

Behavior:

- It is fixed to the bottom edge and accounts for safe-area inset.
- Page content gains enough bottom space that the bar never covers the last row.
- Count changes do not replay the entrance animation.
- Successful state actions clear selection.
- If every selected entry is starred, the star action becomes “Unstar”; otherwise it is “Star” and stars the entire selection. On Starred, bulk Unstar removes matching rows as one group rather than animating each row.
- Open respects the configured tab cap, confirms when the selection exceeds it, opens only the accepted subset, and marks opened entries read.
- Cancel and Escape clear selection without changing entries.
- On compact layouts actions form a stable grid rather than an overflowing horizontal strip.

The first selection causes one entrance; the final deselection causes one exit. Selecting 20 rows must not animate the bar 20 times.

### 8.8 Feed add form

Contains a labeled field accepting a feed URL, site URL, or supported social handle, plus a primary Add button.

- Submit on Enter or Add.
- Ignore accidental leading/trailing whitespace without rewriting visible input while the person types.
- Preserve the submitted value while discovering and validating.
- Disable duplicate submit and show local pending state.
- Use truthful indeterminate copy: “Finding feed…” after the first brief delay and “Still checking…” for an unusually slow discovery. Never invent percent progress.
- Do not expose a Cancel action unless cancellation is guaranteed end to end. Closing or navigating away may detach the waiting surface, but it must not pretend the server operation was cancelled.
- On success, clear the field, update the feed list, and place focus sensibly for another addition.
- On failure, keep the value and show a useful inline error; a toast may summarize but cannot be the only error.
- A duplicate subscription is a specific inline result: “This feed is already subscribed.”
- Successful copy is calm: “Feed added”, without an exclamation mark.

### 8.9 Feed file actions

Import OPML opens a file chooser restricted to relevant formats. After selection it shows a pending state, then reports exact added and skipped counts. A partial import is a warning, not a generic success. Skipped-feed details are shown when supplied. Import adds valid subscription URLs but does not claim they were fetched or healthy; their first refresh determines health. Files above the 2MiB request limit receive a specific size error. Reset the chooser after completion or failure so the same file can be selected again.

Export OPML is a real download link with a stable filename. It requires no success toast because the browser download is the feedback.

### 8.10 Feed list and feed row

Feed row anatomy:

1. feed label linking to Feed detail;
2. source URL;
3. unread count when nonzero;
4. health status;
5. remove action.

Health copy:

- never checked: “Not checked yet”;
- healthy: “Updated `time`”;
- healthy and empty: “Updated `time` · 0 items”;
- failed: “Error”, with persistent diagnostic detail available.

The row prioritizes the label, unread count, and error state when space is constrained. The raw URL truncates first. Remove opens a confirmation naming the feed. After confirmation, the action remains pending until entries and feed state are reconciled; success returns to the Feeds page and reports “Feed removed”. Failure leaves the row in place.

### 8.11 Settings form

Fields:

- maximum tabs opened by a bulk action, 1–500;
- maximum retained entries, 100–100,000;
- maximum entry age in days, optional and 1–36,500 when present.

The form accepts integers only, validates before submission, keeps unsaved values during failure, indicates saving locally, and reports “Settings saved” after success. Leaving with unsaved changes should warn only if the values actually differ from the saved configuration. Starred entries are exempt from both retention limits; help text states this so “maximum” is not misleading.

Port, trusted origins, and the adaptive system appearance are configuration concerns but are intentionally not editable in this UI. The interface must not expose a dead theme selector or imply that a saved port change can take effect without a restart.

### 8.12 Connectivity banner

A local server can restart or become unreachable while the already-loaded page remains open. A persistent, compact banner appears after a request fails for connectivity reasons rather than for a valid application error.

- First failure: keep local content usable and show “Feedreader is unavailable. Reconnecting…”
- While reconnecting: retry with bounded backoff without blocking local scanning.
- Restored: revalidate entries, feeds, configuration, and active refresh state; briefly show “Reconnected”, then dismiss.
- Still unavailable: retain a manual Retry action and never stack identical failure toasts.
- Mutations attempted while unreachable roll back unless a durable offline queue is explicitly designed later. The baseline has no hidden mutation queue.

The banner does not use a looping spinner forever. Its label, retry state, and last attempt provide sufficient feedback.

### 8.13 Keyboard shortcuts dialog

Lists:

| Key | Action |
| --- | --- |
| `j` | Focus next visible entry |
| `k` | Focus previous visible entry |
| `Shift+j` / `Shift+k` | Extend selection through the focused entries |
| `o` | Open focused entry and mark it read |
| `m` | Toggle focused entry read/unread |
| `s` | Toggle focused entry star |
| `x` | Toggle focused entry selection |
| `a` | Mark all unread entries in the active collection/filter read |
| `r` | Refresh when a Refresh action exists on the current page |
| `?` | Open or close shortcut help |
| `Escape` | Dismiss the top temporary mode: field focus, dialog/menu, selection, or row focus |

The dialog opens with `?`, has a visible title and Close action, traps focus, closes on Escape or scrim press, and returns focus to its trigger when one exists.

## 9. Page compositions

### 9.1 Timeline

Order:

1. timeline toolbar;
2. optional new-entries affordance;
3. entry loading/empty/error state or entry list;
4. Show more.

There is no page title when the persistent product shell and active Timeline navigation already provide sufficient context. This preserves vertical density.

### 9.2 Starred

Order:

1. “Starred” page title;
2. starred empty/error state or entry list;
3. Show more.

Unstarring a row removes it with a short local transition. Bulk selection remains available. Timeline-wide actions do not appear here unless they operate unambiguously on the Starred collection.

### 9.3 Feed detail

Order:

1. feed label as page title;
2. timeline toolbar scoped to this feed;
3. optional new-entries affordance;
4. feed-specific entry state/list;
5. Show more.

Counts and bulk actions are scoped to this feed. Refresh remains a global feed refresh unless the backend exposes an explicit single-feed operation; the label must not imply otherwise.

An unknown or removed feed ID shows “Feed not found” with links to Feeds and Timeline. It must not render a generic page titled “Feed” with an empty list.

### 9.4 Feeds

Order:

1. “Feeds” title and total source count;
2. feed add form;
3. Import and Export actions;
4. feed list or no-feeds empty state.

When there are no feeds, the empty state points back to the already-visible add field rather than duplicating another Add action.

### 9.5 Settings

Order:

1. “Settings” title;
2. settings form;
3. Save action.

Settings use a narrower readable measure than entry lists. Each field may include concise help text describing operational consequences.

## 10. Global interaction contracts

### 10.1 Startup

1. Render the stable app shell immediately.
2. Show “Loading saved entries…” in content and the top status region.
3. Load saved entries and feeds independently.
4. Make saved content usable as soon as it arrives.
5. Begin automatic refresh afterward without replacing usable content with a loading screen.
6. Stream confirmed new entries and progress into the interface.

Initial local load and network refresh are separate phases. The refresh indicator must not imply that saved entries are unavailable while network work continues.

Entries, feed metadata, and configuration can fail independently. Entry failure produces the page-level Retry state. Feed metadata failure does not hide already loaded entries; Feed management reports its own error. Configuration failure uses safe displayed defaults for ordinary scanning but Settings shows that saved values could not be loaded. A single failed resource must not blank the whole application.

### 10.2 Navigation and history

- Internal destinations update without a document flash.
- Route change clears entry selection, range anchor, and roving row focus.
- Each destination begins with its default `all` filter and first 50 entries unless route-state restoration is intentionally supported.
- Back/Forward updates active navigation and closes stale overlays.
- Focus moves to the page heading or main content only when navigation was keyboard-initiated; pointer navigation should not create an unexpected visible focus jump.
- Scroll restoration follows browser expectations. Returning to a list should restore position when feasible.

### 10.3 Filtering

- All, Unread, and Read apply to the active collection: Timeline or one Feed detail.
- Filter changes are immediate and reset the visible limit to 50.
- Counts always describe the unpaginated active collection.
- If the focused row disappears, focus moves to the nearest surviving row or the filter control.
- A filter-specific empty state names the filter, such as “No unread entries”.

### 10.4 Optimistic state changes

Read and star changes update immediately. While persistence is pending, the control prevents accidental duplicate toggles or reconciles them in order. On success, no toast is needed. On failure:

1. restore the previous entry state;
2. restore collection counts;
3. preserve selection and focus where possible;
4. show “Could not save state” with useful detail;
5. allow retry through the same control.

### 10.5 Opening entries

- One entry: open a real safe HTTP(S) link in a new tab and mark it read.
- Missing/unsafe link: do not open anything; report “Entry has no safe link”.
- Open all unread: use the active collection and filter, obey the configured cap, and mark only opened entries read.
- Bulk Open: use selected entries across the current visible context, obey the same cap, and mark only opened entries read.
- Popup blocking or partial opening should be reported when detectable; never claim all entries opened without evidence.

### 10.6 Selection

- Selection is a temporary mode local to the current route.
- Single, range, drag, and keyboard selection converge on one selected-ID model.
- The anchor is the most recent explicit selection endpoint.
- Changing read/star state does not clear selection.
- Changing route, Cancel, or Escape clears it.
- Changing the filter clears selection before showing the new result. The interface must never retain invisible selected entries and then act on them silently.

### 10.7 Refresh concurrency and results

- Automatic and manual triggers join the same active refresh rather than creating concurrent runs.
- Refresh actions are pending while the run is active.
- Feed completion, new entry delivery, retained-entry removal, and final health state may arrive at different times; the UI reconciles each without losing local selection or focus.
- Partial failures do not discard successful new entries.
- Failure details name feeds and keep technical text available without placing it permanently in the top bar.
- A completed refresh updates feed health and all visible collection counts.
- A run with zero feeds remains in the no-subscriptions state and points to Feeds instead of playing a success animation.
- If a feed is added or removed during a run, the running total continues to describe that run’s original snapshot. The next run uses the new subscription set.
- Final `removed` IDs are authoritative whether caused by retention, a deleted feed, or rollback. The UI removes them from entries, selection, and focus exactly once.

### 10.8 Destructive actions

Deleting a feed requires confirmation. The dialog states that the subscription and its cached entries will be removed. The feed name is included. Cancel is always available. The app must not use optimistic disappearance for destructive data removal unless it can reliably restore the entire feed and entry state.

### 10.9 Input contexts and shortcuts

Single-letter shortcuts are suspended while focus is in an input, text area, select, or editable region. Escape first blurs the active field. Modified browser/OS shortcuts are never intercepted. Pointer movement after keyboard row navigation removes the synthetic row-focus treatment only when a mouse actually takes over; touch movement must not erase state unexpectedly.

### 10.10 Overlay dismissal priority

Escape dismisses only the highest active layer per press:

1. confirmation/dialog;
2. popover or compact navigation;
3. bulk selection mode;
4. roving entry focus;
5. focused form field.

This avoids one Escape press unexpectedly clearing several unrelated states.

### 10.11 Revalidation and changes from elsewhere

Feedreader’s files can be synchronized and the app can be open in more than one tab. The UI must assume saved read/star state, subscriptions, retention results, or entries may change outside its current in-memory view.

- Revalidate when the page becomes visible after more than roughly 60 seconds in the background, after reconnecting, and after a completed refresh that merged external state.
- Reconciliation uses persisted timestamps as authoritative and does not replay local entrance animations for old changes.
- Preserve the active route, filter, and scroll anchor when possible.
- Remove stale selected IDs and move focus to the nearest surviving row.
- If unsaved local form edits conflict with newly loaded settings, do not overwrite the fields; show that saved settings changed elsewhere and offer Reload or Keep editing.
- Multiple tabs must converge after revalidation. They do not need real-time cursor or presence UI.

### 10.12 Background and time behavior

- Relative timestamps refresh at a low cadence while the page is visible and immediately after returning from the background. They do not animate.
- Polling and decorative animation may pause while the page is hidden; confirmed refresh state is fetched immediately on return.
- A system light/dark change applies without a page flash and preserves every interaction state.
- A system reduced-motion change takes effect for subsequent transitions without requiring reload.

### 10.13 Content extremes and localization

- Counts use localized grouping and preserve the exact value for assistive technology. Compact visual abbreviation is allowed only when space requires it.
- Very long and unbroken titles, labels, URLs, and error messages wrap or truncate within their component; they never widen the page.
- Empty strings use the documented fallbacks.
- Feed text containing markup is displayed as text, not interpreted as interface markup.
- Mixed-direction and right-to-left content is isolated from control layout. If the product itself is localized into a right-to-left language, navigation, progress fill direction, row order, and directional icons follow the interface direction.
- Dates and numbers use the user’s locale. Product action labels remain consistent within one chosen language.

### 10.14 Long-running scoped operations

Add-feed discovery, OPML import, feed removal, Settings save, and refresh may outlive a quick route change.

- Navigation is not blocked unless leaving would discard unsaved typed values.
- A completed operation updates the relevant global data even if its originating page is no longer visible.
- Success feedback names the result without forcibly navigating back.
- Failure is retained until the originating surface can show it or is summarized by persistent global feedback.
- Repeated activation cannot create duplicate operations for the same object.

## 11. Responsive behavior

Responsive decisions follow available component width, with approximately 640px as the current compact transition point.

### 11.1 Regular width

- Show product, refresh status, and destination links in one top bar.
- Keep the content column centered at a maximum 720px.
- Keep filter and timeline actions on one row when they fit.
- Selection bar is a compact centered action surface at the bottom.
- Pointer hover reveals affordances but is never required.

### 11.2 Compact width

- Keep product and refresh graphic visible; truncate or temporarily omit long refresh text first.
- Replace destination links with the compact navigation menu.
- Use 8–12px page gutters plus safe-area insets.
- Make the segmented filter a three-column full-width control.
- Wrap timeline actions into equal-width controls below it.
- Preserve visible star and read controls with 44px hit targets.
- Use a bottom selection grid above the safe area; reserve content space for its full height.
- Stack toasts above the selection bar.
- Feed rows prioritize label, unread badge/error, and remove action; truncate the raw URL.
- Feed Add remains one row while viable, then may place Add beneath the input at very narrow widths.
- Dialogs fit within gutters and never exceed the dynamic viewport height.

### 11.3 Pointer capability

- Hover styles are wrapped in hover-capable conditions.
- Coarse pointers get larger hit regions and no hover-dependent disclosure.
- Drag selection begins only in the checkbox lane so vertical page scrolling elsewhere remains native.
- There are no swipe actions. They hide affordances, collide with browser navigation, and add an interaction model the product does not need.

## 12. Accessibility contract

- Use semantic navigation, main, headings, lists, links, buttons, forms, status, progress, dialog, and alert semantics.
- Heading order follows the page hierarchy; a visually omitted Timeline title may remain available to assistive technology.
- Current navigation, selected filters, pressed star/read controls, selected entries, disabled actions, and progress values expose their state programmatically.
- Every visible action is reachable and operable by keyboard.
- Roving `j`/`k` focus is additive; it does not replace normal Tab navigation.
- Focus rings are never suppressed without an equivalent visible focus style.
- Dialogs trap focus and restore it. Popovers and menus manage focus without trapping the whole application unnecessarily.
- Live announcements are polite for progress and success, assertive only for failures that block the current task.
- Dynamic counts are not announced on every incidental mutation unless the user triggered it.
- Text remains usable at 200% zoom and with browser text enlargement.
- Color contrast is checked in both appearances and in selected/read/disabled combinations.
- All motion has a reduced-motion path.
- Touch targets meet 44×44px where space permits; tightly packed desktop targets still have clear focus and do not overlap.

## 13. Content and microcopy

Tone is plain, compact, and calm. Use sentence case and no celebratory punctuation for routine work.

| Situation | Preferred copy |
| --- | --- |
| Initial data | Loading saved entries… |
| Refresh start | Starting refresh… |
| Refresh active | Checking feeds `12/41` · `3 new` |
| Refresh success | Up to date |
| Refresh with content | `3 new` |
| Partial refresh | Checked · `2` failed |
| Refresh failure | Refresh failed |
| No active-filter entries | No unread entries / No read entries |
| No entries at all | No entries yet |
| No feeds | No feeds yet. Add one above. |
| Add success | Feed added |
| Remove success | Feed removed |
| State failure | Could not save state |
| Settings success | Settings saved |
| Unsafe link | Entry has no safe link |
| Mark-all result | `18` marked as read |
| Import result | `12` feeds imported · `3` skipped |

Errors should state what failed and, when useful, what the person can do next. Raw parser/network details may be available in diagnostic detail but should not replace the plain summary.

Relative time vocabulary:

- just now;
- `12m ago`;
- `3h ago`;
- yesterday;
- `4d ago`;
- localized month and day afterward.

## 14. Deliberate exclusions

The baseline system does not include:

- an in-app article reader;
- swipe gestures;
- push notifications;
- animation on every route or list update;
- infinite automatic scrolling;
- a permanently visible global search field;
- per-page styling dialects;
- multiple visual themes beyond the adaptive system appearance;
- hidden destructive gestures.

Search should return only with a defined retrieval model and keyboard interaction. Feed folders are supported by the data model but have no current UI; see the extension point below.

## 15. Known extension points

These are not baseline requirements, but the system must leave room for them without redesigning existing primitives.

### 15.1 Feed folders

Future components:

- folder section with label and unread count;
- collapsible feed group;
- folder picker in feed add/edit flow;
- folder destination/filter;
- empty-folder state.

Folder disclosure must be keyboard operable and should not make the current flat feed list slower or more complex when there are no folders.

### 15.2 Search

A future search surface should reuse the field, empty state, entry list, and keyboard-focus contracts. Search results must state their scope and preserve the same entry actions. It should not be reintroduced as an always-visible field without evidence that persistent space is justified.

### 15.3 Refresh detail

The baseline failure disclosure lists failed feeds and their errors. A future richer progress popover may also contain last refresh time, new-entry history, and retry controls. The compact indicator must remain useful without opening that richer surface.

## 16. Component inventory

This is the implementation checklist. A named component should have one canonical contract.

### Foundations

- App surface
- Page container
- Page header
- Stack and inline layout primitives
- Divider/hairline
- Text styles
- Icon
- Visually hidden text
- Focus ring

### Navigation and shell

- App shell
- Document metadata
- Top bar
- Product link
- Primary navigation
- Navigation link
- Compact navigation trigger
- Compact navigation menu
- Scrim
- Refresh progress indicator
- Refresh status detail popover

### Controls

- Button: primary, secondary, quiet, danger, file
- Icon button
- Segmented filter
- Checkbox
- Selection lane
- Text field
- Number field
- Field label
- Field help and validation message
- File input trigger
- Keyboard hint

### Feedback and layers

- Badge: unread, neutral, success, warning, danger
- Inline status
- Progress
- Tooltip
- Popover
- Dialog
- Confirmation dialog
- Toast and toast region
- Empty state
- Loading state
- Inline error
- Page error
- Connectivity banner
- Reconnection state

### Entries

- Timeline toolbar
- Entry list
- Entry row
- Entry title link
- Entry metadata
- Entry star action
- Entry read action
- Show-more control
- New-entries affordance
- Bulk selection bar

### Feeds

- Feed add form
- Feed file actions
- Feed list
- Feed row
- Feed title link
- Feed URL metadata
- Feed unread badge
- Feed health status
- Feed remove action and confirmation
- OPML import result detail

### Settings and help

- Settings form
- Settings field
- Keyboard shortcuts dialog

### Page compositions

- Timeline page
- Starred page
- Feed detail page
- Feeds page
- Settings page
- Not-found page

## 17. Interaction inventory

Before the UI system is considered complete, verify all of these flows with mouse, keyboard, and touch where applicable:

### Shell and navigation

- Navigate by product link and each destination link.
- Keep Feeds current while viewing Feed detail and update the browser title for every route.
- Open, close, select from, click outside, press Escape in, and navigate Back while using the compact menu.
- Restore active navigation and sensible scroll/focus through browser history.

### Refresh

- Load saved entries before refresh.
- Start automatically and manually.
- Join an already-running refresh.
- Show zero, partial, and full progress.
- Receive new entries during progress.
- Finish with zero new, some new, partial failures, and total failure.
- Expand, fill, settle, collapse, and immediately restart the progress indicator.
- Inspect long failure detail.
- Use reduced motion and assistive progress announcements.
- Refresh with no subscriptions.
- Add or remove a subscription during an active run.
- Stream provisional entries and then roll them back after total failure.
- Prune old entries at completion, including selected or keyboard-focused rows.
- Reconcile a provisional new count with a smaller retained final count.

### Entry scanning and opening

- Hover/focus/touch a row.
- Open with pointer, Enter, modifier click, middle click, context menu, and `o`.
- Handle a missing/unsafe URL.
- Mark read/unread and star/unstar successfully and with rollback.
- Remove one row from an active filter without losing usable focus.
- Receive new rows while at the top and while scrolled away.
- Show 50 more until all are visible.
- Render untitled, unknown-source, invalid-date, future-date, mixed-direction, markup-like, and extremely long content safely.
- Update relative timestamps after time passes and after returning from the background.

### Selection and bulk work

- Select/deselect one checkbox.
- Shift-select in both directions.
- Drag-select and drag-deselect in both directions.
- Select with `x` and extend with `Shift+j`/`Shift+k`.
- Combine selected, read, starred, hover, and keyboard-focus states.
- Mark selected read, unread, and starred.
- Open below, at, and above the tab cap; cancel the confirmation.
- Cancel with the button and Escape.
- Change filters and routes with active selection.
- Keep the last row visible above the compact selection bar.

### Feeds

- Add a direct feed URL, discover from a site URL, and add a supported handle.
- Submit invalid, unsafe, duplicate, slow, and failed sources.
- Navigate away during slow discovery, then reconcile its eventual success or failure without claiming it was cancelled.
- Import no file, a valid file, a partial file, an invalid file, and a large file.
- Select the same OPML file twice in succession.
- Export OPML.
- Inspect never-checked, healthy, healthy-empty, and failed feed health.
- Open a Feed detail route.
- Remove and cancel removal; handle removal failure.

### Settings and help

- Validate each boundary and optional empty maximum age.
- Save, fail, retry, and leave with unsaved changes.
- Open shortcuts with `?`, traverse it, close by button, Escape, and scrim, and restore focus.
- Ensure shortcuts do not fire while typing or using modified keys.

### Feedback and accessibility

- Stack toasts at regular and compact widths, with and without the bulk bar.
- Navigate all controls by Tab and activate them without a pointer.
- Test 200% zoom, text enlargement, light/dark appearance, high contrast where available, and reduced motion.
- Test narrow viewport, safe-area inset, coarse pointer, hover-capable pointer, and screen-reader announcements.
- Confirm no loading, empty, failure, disabled, or pending state causes layout jitter.
- Stop the local server, keep scanning loaded content, reconnect, and reconcile changes.
- Change read/star state in another tab or synchronized file, then revalidate without destroying route, filter, or scroll position.

## 18. Decisions still open

These choices require a visual prototype or an explicit product decision. They are not permission for page-local improvisation.

| Decision | Fixed boundary |
| --- | --- |
| Exact ordinary control and overlay radii | Rows remain square/nearly square; capsules remain reserved for progress/status |
| Final icon family and product mark | One family only; no platform-dependent emoji controls |
| Exact refresh-result hold time | Completion must be readable and must not become persistent noise |
| Whether healthy refresh detail opens on demand | Failure detail is required regardless |
| Exact responsive transition widths | Behavior is component-width driven; compact contracts remain fixed |
| Whether leaving a dirty Settings form uses a dialog or route-level prompt | Unsaved changes cannot be silently discarded |
| Whether compact count badges abbreviate large values | Exact value remains available and accessible |

When a decision is made, move it into the relevant normative section and remove its row here.

## 19. Quality gate for every component

A component is not finished until it has:

1. a named purpose and canonical anatomy;
2. all relevant interaction states;
3. keyboard, pointer, touch, and screen-reader behavior;
4. regular and compact layout behavior;
5. light and dark appearance;
6. reduced-motion behavior;
7. loading, empty, error, and pending behavior where applicable;
8. long-content, localization, zoom, and truncation behavior;
9. no unexpected layout shift;
10. no duplicated page-local variant that should be the same component.

The UI is complete when the common path feels nearly instantaneous, uncommon states remain understandable, and motion is noticeable mainly because it makes a change easier to follow.
