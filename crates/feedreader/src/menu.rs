#[cfg(target_os = "macos")]
pub type Menu = muda::Menu;

#[cfg(not(target_os = "macos"))]
pub type Menu = ();

#[cfg(target_os = "macos")]
pub fn install(event_loop: &winit::event_loop::ActiveEventLoop) -> Option<Menu> {
    use muda::{PredefinedMenuItem as Item, Submenu};
    use winit::platform::macos::ActiveEventLoopExtMacOS;
    event_loop.set_allows_automatic_window_tabbing(false);
    let app = Submenu::with_items(
        "Feedreader",
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
pub fn install(_: &winit::event_loop::ActiveEventLoop) -> Option<Menu> {
    None
}
