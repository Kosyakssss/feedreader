mod foundations;
mod actions;
mod controls;
mod scrolling;
mod navigation;
mod data;
mod commands;

use crate::commands::{Chord, Command, Key, Registry};
use crate::field::Field;
use crate::kit::{Align, Column, Found, Kind, Node, Palette, Place, Table, Tone, Value};
use crate::grid::Area;
use crate::specimen::{Hit, Sandbox, Sheet};
use crate::state::Id;
use crate::text::{Block, Face, SpanStyle, TextStyle};
use crate::ui::{List, Scene, contrast, to_oklch};
use foundations::*;
use actions::*;
use controls::*;
use scrolling::*;
use navigation::*;
use data::*;
use commands::*;

pub fn all() -> Vec<Sheet> {
    vec![
        Sheet::new("Foundations", "Grid", grid),
        Sheet::new("Foundations", "Ink", ink),
        Sheet::new("Foundations", "Type", type_sheet),
        Sheet::new("Foundations", "Lines", lines),
        Sheet::new("Foundations", "Characters", characters),
        Sheet::new("Foundations", "Values", values),
        Sheet::new("Foundations", "Pictures", pictures),
        Sheet::new("Foundations", "Canvas", canvas),
        Sheet::new("Actions", "Button", buttons),
        Sheet::new("Actions", "Keys and actions", actions),
        Sheet::new("Actions", "Link", links),
        Sheet::new("Navigation", "Tabs, places and breadcrumb", navigation),
        Sheet::new("Feedback", "Status, message and confirm", feedback),
        Sheet::new("Data", "Spec sheet", spec_sheet),
        Sheet::new("Data", "Table", table).filling(),
        Sheet::new("Data", "Tree", tree),
        Sheet::new("Commands", "Action bar and help", commands),
        Sheet::new("Commands", "Palette", palette).filling(),
        Sheet::new("Controls", "Checkbox", checkbox),
        Sheet::new("Controls", "Radio, switch and cycle", choices),
        Sheet::new("Controls", "Stepper and progress", steppers),
        Sheet::new("Controls", "Field", field),
        Sheet::new("Controls", "Text area", text_area),
        Sheet::new("Scrolling", "List", list).filling(),
        Sheet::new("Scrolling", "Scroll area", scroll_area).filling(),
    ]
}

pub(super) fn caption(s: &mut Scene<Hit>, a: Area, text: &str) {
    let muted = s.palette.muted;
    let mono = s.m.mono();
    s.write(a, text, mono, muted);
}

pub(super) fn forced<R>(s: &mut Scene<Hit>, a: Area, hover: bool, press: bool, f: impl FnOnce(&mut Scene<Hit>) -> R) -> R {
    let (pointer, pressed) = (s.pointer, s.pressed);
    let r = s.rect(a.at(0, 0, 2, 1));
    s.pointer = hover.then_some((r.x + r.w / 2.0, r.y + r.h / 2.0));
    s.pressed = press;
    let out = f(s);
    (s.pointer, s.pressed) = (pointer, pressed);
    out
}

pub(super) const STATES: [(&str, bool, bool, bool); 4] = [("normal", false, false, true), ("hover", true, false, true), ("pressed", true, true, true), ("disabled", false, false, false)];

pub(super) fn state_rows(s: &mut Scene<Hit>, a: &mut Area, title: &str, mut draw: impl FnMut(&mut Scene<Hit>, Area, bool)) {
    caption(s, a.take_top(1), title);
    let row = a.take_top(2);
    let mut col = 0;
    for (name, hover, press, enabled) in STATES {
        let cell = row.at(col, 0, 24, 2);
        caption(s, cell.line(1), name);
        forced(s, cell.line(0), hover, press, |s| draw(s, cell.line(0), enabled));
        col += 26;
    }
    a.take_top(1);
}
