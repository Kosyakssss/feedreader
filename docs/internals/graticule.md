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
