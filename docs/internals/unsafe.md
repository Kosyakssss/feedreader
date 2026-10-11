# Unsafe

The workspace denies `unsafe_code`. Each exception below is approved by the owner, allowed by name on one function, and explained here. Adding another needs the owner's sign-off first, with the same proof.

## The macOS context menu (`graticule::menu::popup`)

A native context menu on macOS is an `NSMenu` popped up in an `NSView`, so every API for it needs the window's view. winit exposes that view only as a raw pointer (`raw-window-handle`'s `AppKitWindowHandle::ns_view`), with no safe typed accessor. muda's only macOS popup, `ContextMenu::show_context_menu_for_nsview`, takes that raw pointer and is `unsafe`; the alternative, objc2's typed `&NSView` APIs, needs `unsafe` to turn the pointer into a reference. The safe alternative is a menu we draw ourselves, which is not native.

The call is sound because the pointer comes from the live window the shell owns, it is used synchronously on the main thread, and muda only reads it to position the popup.

The lint is `deny` rather than `forbid` because `forbid` cannot be overridden even for one function.
