#![forbid(unsafe_code)]

mod actions;
mod api;
mod common;
mod input;
mod state;
mod ui;

use api::Api;
use crossterm::event::{
    DisableBracketedPaste, DisableFocusChange, DisableMouseCapture, EnableBracketedPaste,
    EnableFocusChange, EnableMouseCapture, Event, EventStream,
};
use futures_util::StreamExt;
use state::App;
use std::{
    io,
    process::Command,
    time::{Duration, Instant},
};
use tokio::sync::mpsc;
use ui::Palette;

fn light_mode() -> bool {
    if let Ok(value) = std::env::var("COLORFGBG")
        && let Some(number) = value
            .split(';')
            .next_back()
            .and_then(|part| part.parse::<u8>().ok())
    {
        return number >= 7;
    }
    if cfg!(target_os = "macos") {
        return !Command::new("defaults")
            .args(["read", "-g", "AppleInterfaceStyle"])
            .output()
            .is_ok_and(|output| {
                output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == "Dark"
            });
    }
    false
}

fn args() -> Result<(String, bool, bool), String> {
    let mut address = std::env::var("FEEDREADER_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:8787/feedreader".into());
    let mut light = light_mode();
    let mut check = false;
    let mut items = std::env::args().skip(1);
    while let Some(item) = items.next() {
        match item.as_str() {
            "--server" => address = items.next().ok_or("--server needs a URL")?,
            "--light" => light = true,
            "--dark" => light = false,
            "--check" => check = true,
            "--help" | "-h" => {
                println!(
                    "Usage: feedreader-tui [--server URL] [--light|--dark] [--check]\n\nDefault server: http://127.0.0.1:8787/feedreader\nFEEDREADER_URL sets the server URL. --check verifies the connection without opening the TUI."
                );
                std::process::exit(0);
            }
            _ => return Err(format!("Unknown argument: {item}")),
        }
    }
    Ok((address, light, check))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let (address, light, check) = args()?;
    let api = Api::new(&address)?;
    if check {
        let snapshot = api.sync().await?;
        println!(
            "Connected: {} feeds, {} entries",
            snapshot.feeds.feeds.len(),
            snapshot.entries.len()
        );
        return Ok(());
    }
    let (tx, mut rx) = mpsc::unbounded_channel();
    let mut app = App::new(api.clone(), tx.clone(), Palette::new(light));
    app.sync();
    tokio::spawn(async move { api.events(tx).await });
    let mut terminal = ratatui::init();
    crossterm::execute!(
        io::stdout(),
        EnableMouseCapture,
        EnableBracketedPaste,
        EnableFocusChange
    )?;
    let mut events = EventStream::new();
    let mut tick = tokio::time::interval(Duration::from_millis(250));
    let mut last_age_update = Instant::now();
    let result = async {
        let mut dirty = true;
        loop {
            if dirty {
                app.hits.clear();
                terminal.draw(|frame| ui::draw(frame, &mut app))?;
                dirty = app.refresh_hover();
                if dirty {
                    continue;
                }
            }
            if app.quit {
                break;
            }
            tokio::select! {
                Some(message) = rx.recv() => { app.handle_message(message); dirty = true; },
                event = events.next() => match event {
                    Some(Ok(Event::Key(key))) => { app.key(key); dirty = true; },
                    Some(Ok(Event::Mouse(mouse))) => dirty = app.mouse(mouse),
                    Some(Ok(Event::Paste(text))) => { app.paste(&text); dirty = true; },
                    Some(Ok(Event::Resize(_, _))) => { app.clamp_scroll(); dirty = true; },
                    Some(Ok(Event::FocusLost)) => { app.pointer = None; app.hovered = None; dirty = true; },
                    Some(Err(error)) => return Err(error),
                    None => break,
                    _ => {}
                },
                _ = tick.tick() => {
                    dirty = app.expire_notice();
                    if last_age_update.elapsed() >= Duration::from_secs(30) { dirty = true; last_age_update = Instant::now(); }
                },
            }
        }
        Ok::<(), io::Error>(())
    }
    .await;
    crossterm::execute!(
        io::stdout(),
        DisableBracketedPaste,
        DisableMouseCapture,
        DisableFocusChange
    )?;
    ratatui::restore();
    result?;
    Ok(())
}
