# Graticule

## Measuring counts trailing spaces

`Text::measure` uses parley's `full_width`, not `width`. `width` leaves out trailing whitespace, so anything placed after a measured prefix that ends in a space (the caret, the rest of a field's text, a selection) lands one space too far left per space.

## The focused field comes before the registry

A key reaches the focused field before the command registry, and only keys the field ignores go on to commands. That is what lets Home, End, Cmd-A, Cmd-Z and the Ctrl bindings edit text while a field has focus, and Cmd-C fall through to the app's copy when nothing is selected. Ctrl chords outside a field still go to the system, so window shortcuts like Globe-Ctrl-F keep working.

## Fields report where they were painted

`Scene::field` records every field's rectangle and, for the focused one, its text origin and caret. The shell keeps them from the last frame to place the caret under the mouse and to place the input method's candidate window, so an app never passes geometry back by hand.

## Launch

On an M1 with a warm cache, a window shows its first frame about 160 ms after the process starts: about 15 ms before `main`, about 75 ms for AppKit to finish launching, about 40 ms to create the window, 5 ms for the GPU surface and about 20 ms for the app to attach to the engine, take its snapshot and paint. Loading the fonts takes about 35 ms, so it runs on its own thread from the start of `run` and is joined when the window exists, which hides it behind AppKit's startup.

## Context menus open at the mouse

muda converts a position given to `show_context_menu_for_nsview` as if the view were unflipped, but winit's view is flipped, so menus opened upside down relative to the click. The shell passes no position, and muda uses the mouse location in screen coordinates.

## Scroll positions belong to Graticule and follow an item

Lists and scroll areas keep their scroll state in `graticule::state::State`, keyed by an `Id` the app chooses, so painting never writes into the app's model. A list's position is the item at the top (by the key the app gives each item) plus an offset into it, not a pixel distance from the start. When items arrive above, move or disappear, the list finds the same item again and keeps it where it was, so nothing moves under the reader. The position is only recomputed from the total when it falls out of range; recomputing every frame drifts the offset by float rounding. Commands that need the layout (a page down that moves a cursor) read it from the state handed to `App::exec`. With `Scrolling::Rows` (the default) the wheel and the scrollbar move by whole rows like a terminal; `Scrolling::Smooth` follows the trackpad by the pixel.

## Character graphics are drawn, not taken from the font

Box drawing (U+2500–U+257F), block elements (U+2580–U+259F) and braille (U+2800–U+28FF) are drawn by `chars.rs` as rectangles snapped to device pixels, so lines meet exactly at cell edges whatever the font, size or scale. Each box character is four arms (up, right, down, left) of none, light, heavy or double weight. An arm's inner end depends on the arms across it, so joins have no gaps: a single line covers the line it meets, and of a double line's two strokes, the one on the side of a crossing arm stops at that arm's near stroke while the outer one runs to its far stroke, which gives double corners their inner and outer turns. Arcs and diagonals are paths rasterized once per cell size into the glyph atlas. Mono text that contains any of these characters is laid out cell by cell (`Scene::cells`); boxes and rules (`frame`, `rule`, `vrule`) are strings of the current line style's characters.

## Moves that need the layout go through the shell

`Field` is a pure editing model and doesn't know where its text wrapped. In a multi-line field, up, down and the line ends return `Edit::Line`, and the shell answers them from the layout the field was last painted with (`Focused.wrap`), using parley's line navigation. Everything else, including Return, Cmd with the arrows and Ctrl-K up to the end of the line, stays in the model, so the field law covers it.

## Selection is resolved after the frame

Every piece of text drawn while `Scene::selectable` is on is recorded as a run: its layout's key, origin, visible rectangle and where its glyph quads start. A selection end is a run's layout key, its position in drawing order and a byte offset. Painting doesn't know where a selection starts until every run is drawn, so `Scene::finish` matches each end to the run with the same key nearest its old position, then inserts the highlight quads just before each selected run's glyphs. Matching by key rather than position keeps a selection on the same text when a list scrolls or entries arrive; a selection whose text is gone is dropped. Copying reads the text back from the layout cache, joining runs on one row with a space and rows with a newline.

## Accessibility comes from what was painted

Every app gets an AccessKit tree without describing one: the shell builds it after each frame, only while an assistive technology is listening, from what the frame recorded. Each clickable area becomes a button labelled by the text drawn inside it, other text becomes labels, fields become text inputs with the focused one's value, all in drawing order. A click from VoiceOver presses the same hit a mouse would. Text that opts out of selection is still recorded, flagged, so it stays readable. The window is created hidden and shown after the adapter exists, as AccessKit requires on macOS. Components can give richer roles (lists, checkboxes, tabs) as the library grows; `specimen --snapshot … --access` prints the tree.

## Proofs are rendered offscreen at a fixed size

A proof is a sheet rendered by its own offscreen GPU device at scale 2, 100 columns (or the frame's width) by 40 rows, with an empty sandbox, so it doesn't depend on the window's size, what was clicked or the paint time in the header. Approving writes it as a PNG under the platform data folder (`Graticule/Specimen/<app>/`), one file per sheet, line style, appearance and width; it isn't committed, since a round of approvals would add megabytes of images to the history. Checking renders the sheet again and compares pixels exactly; a difference also writes a `.diff.png` with the changed pixels in red over a faded copy, which the window shows on request.

## Pictures map colors to inks at build time

Engraver doesn't keep an SVG's colors: each fill and stroke takes the semantic ink nearest its color in the light palette (black and near-black are ink, greys are muted, faint or rule, blue is link, red danger, amber warn, green ok, white the background), so a picture follows the theme and the appearance like text does. Draw pictures in those colors to get the ink you mean. Paths are flattened with their transforms at build time; stroke widths stay in picture units, since zeno strokes before it scales. Text and embedded images in an SVG are dropped: a picture with words in it should be text instead.

## A canvas transforms points, not strokes

Canvas paths are kept in the canvas's coordinates and mapped to pixels point by point before they're rasterized, so a chart can stretch differently across and down while its strokes stay one, two or three device pixels wide and its dots stay round. Each mapped path is rasterized once into the glyph atlas and cached by its points; a canvas that changes every frame keeps adding new shapes, and when the atlas fills it is cleared along with the glyphs. A canvas registers its rectangle as sensitive, so moving the pointer inside it repaints and hit testing follows the shape under the pointer, not the canvas's rectangle.
