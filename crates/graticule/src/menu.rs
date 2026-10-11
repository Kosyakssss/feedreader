#[cfg(target_os = "macos")]
pub type Menu = muda::Menu;

#[cfg(not(target_os = "macos"))]
pub type Menu = ();

#[cfg(target_os = "macos")]
pub fn install(event_loop: &winit::event_loop::ActiveEventLoop, title: &str) -> Option<Menu> {
    use muda::{PredefinedMenuItem as Item, Submenu};
    use winit::platform::macos::ActiveEventLoopExtMacOS;
    event_loop.set_allows_automatic_window_tabbing(false);
    let app = Submenu::with_items(
        title,
        true,
        &[
            &Item::about(None, None),
            &Item::separator(),
            &Item::services(None),
            &Item::separator(),
            &Item::hide(None),
            &Item::hide_others(None),
            &Item::show_all(None),
            &Item::separator(),
            &Item::quit(None),
        ],
    )
    .ok()?;
    let window = Submenu::with_items(
        "Window",
        true,
        &[&Item::minimize(None), &Item::zoom(None), &Item::fullscreen(None), &Item::separator(), &Item::bring_all_to_front(None)],
    )
    .ok()?;
    let menu = muda::Menu::with_items(&[&app, &window]).ok()?;
    menu.init_for_nsapp();
    window.set_as_windows_menu_for_nsapp();
    Some(menu)
}

#[cfg(not(target_os = "macos"))]
pub fn install(_: &winit::event_loop::ActiveEventLoop, _: &str) -> Option<Menu> {
    None
}

#[cfg(target_os = "macos")]
fn accelerator(chord: &crate::commands::Chord) -> Option<muda::accelerator::Accelerator> {
    use crate::commands::Key;
    use muda::accelerator::{Accelerator, Code, Modifiers};
    const LETTERS: [Code; 26] = [Code::KeyA, Code::KeyB, Code::KeyC, Code::KeyD, Code::KeyE, Code::KeyF, Code::KeyG, Code::KeyH, Code::KeyI, Code::KeyJ, Code::KeyK, Code::KeyL, Code::KeyM, Code::KeyN, Code::KeyO, Code::KeyP, Code::KeyQ, Code::KeyR, Code::KeyS, Code::KeyT, Code::KeyU, Code::KeyV, Code::KeyW, Code::KeyX, Code::KeyY, Code::KeyZ];
    const DIGITS: [Code; 10] = [Code::Digit0, Code::Digit1, Code::Digit2, Code::Digit3, Code::Digit4, Code::Digit5, Code::Digit6, Code::Digit7, Code::Digit8, Code::Digit9];
    let mut mods = Modifiers::empty();
    if chord.cmd {
        mods |= Modifiers::META;
    }
    if chord.shift {
        mods |= Modifiers::SHIFT;
    }
    let code = match chord.key {
        Key::Char(c) if c.is_ascii_lowercase() => LETTERS[(c as u8 - b'a') as usize],
        Key::Char(c) if c.is_ascii_digit() => DIGITS[(c as u8 - b'0') as usize],
        Key::Char('[') => Code::BracketLeft,
        Key::Char(']') => Code::BracketRight,
        Key::Char('?') => {
            mods |= Modifiers::SHIFT;
            Code::Slash
        }
        Key::Enter => Code::Enter,
        Key::Escape => Code::Escape,
        Key::Up => Code::ArrowUp,
        Key::Down => Code::ArrowDown,
        Key::Left => Code::ArrowLeft,
        Key::Right => Code::ArrowRight,
        Key::PageUp => Code::PageUp,
        Key::PageDown => Code::PageDown,
        Key::Home => Code::Home,
        Key::End => Code::End,
        Key::Backspace => Code::Backspace,
        Key::Delete => Code::Delete,
        _ => return None,
    };
    Some(Accelerator::new(mods, code))
}

#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
pub fn popup(window: &winit::window::Window, items: &[(u32, String, Option<crate::commands::Chord>)]) -> Option<u32> {
    use muda::ContextMenu;
    use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let menu = muda::Menu::new();
    for (id, label, chord) in items {
        menu.append(&muda::MenuItem::with_id(id.to_string(), label, true, chord.as_ref().and_then(accelerator))).ok()?;
    }
    let RawWindowHandle::AppKit(view) = window.window_handle().ok()?.as_raw() else { return None };
    while muda::MenuEvent::receiver().try_recv().is_ok() {}
    let shown = unsafe { menu.show_context_menu_for_nsview(view.ns_view.as_ptr(), None) };
    if !shown {
        return None;
    }
    muda::MenuEvent::receiver().try_recv().ok().and_then(|e| e.id.0.parse().ok())
}

#[cfg(not(target_os = "macos"))]
pub fn popup(_: &winit::window::Window, _: &[(u32, String, Option<crate::commands::Chord>)]) -> Option<u32> {
    None
}
