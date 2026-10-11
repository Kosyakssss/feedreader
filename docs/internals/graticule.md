# Graticule

## Measuring counts trailing spaces

`Text::measure` uses parley's `full_width`, not `width`. `width` leaves out trailing whitespace, so anything placed after a measured prefix that ends in a space (the caret, the rest of a field's text, a selection) lands one space too far left per space.

## The focused field comes before the registry

A key reaches the focused field before the command registry, and only keys the field ignores go on to commands. That is what lets Home, End, Cmd-A, Cmd-Z and the Ctrl bindings edit text while a field has focus, and Cmd-C fall through to the app's copy when nothing is selected. Ctrl chords outside a field still go to the system, so window shortcuts like Globe-Ctrl-F keep working.

## Fields report where they were painted

`Scene::field` records every field's rectangle and, for the focused one, its text origin and caret. The shell keeps them from the last frame to place the caret under the mouse and to place the input method's candidate window, so an app never passes geometry back by hand.

## Launch

On an M1 with a warm cache, a window shows its first frame about 160 ms after the process starts: about 15 ms before `main`, about 75 ms for AppKit to finish launching, about 40 ms to create the window, 5 ms for the GPU surface and about 20 ms for the app to attach to the engine, take its snapshot and paint. Loading the fonts takes about 35 ms, so it runs on its own thread from the start of `run` and is joined when the window exists, which hides it behind AppKit's startup.
