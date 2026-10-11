use std::fmt::Write;
use std::path::Path;

use usvg::tiny_skia_path::PathSegment;
use usvg::{FillRule, Node, Paint};

const INKS: [(&str, [u8; 3]); 11] = [
    ("Ink", [0x1a, 0x1a, 0x1c]),
    ("Ink", [0x00, 0x00, 0x00]),
    ("Muted", [0x73, 0x73, 0x78]),
    ("Faint", [0x9e, 0x9e, 0xa3]),
    ("Rule", [0xb8, 0xb8, 0xba]),
    ("Link", [0x21, 0x52, 0xa8]),
    ("Danger", [0xb8, 0x29, 0x21]),
    ("Warn", [0x9e, 0x6b, 0x0d]),
    ("Ok", [0x21, 0x78, 0x40]),
    ("Background", [0xf9, 0xf9, 0xf7]),
    ("Background", [0xff, 0xff, 0xff]),
];

fn ink(paint: &Paint) -> &'static str {
    let Paint::Color(c) = paint else { return "Ink" };
    let d = |rgb: [u8; 3]| [c.red, c.green, c.blue].iter().zip(rgb).map(|(a, b)| (*a as i32 - b as i32).pow(2)).sum::<i32>();
    INKS.iter().min_by_key(|(_, rgb)| d(*rgb)).map_or("Ink", |(name, _)| name)
}

fn title(svg: &str) -> Option<String> {
    let start = svg.find("<title")?;
    let open = start + svg[start..].find('>')? + 1;
    let close = open + svg[open..].find("</title>")?;
    let text = svg[open..close].trim();
    (!text.is_empty()).then(|| text.replace('"', "\\\""))
}

fn path_data(path: &usvg::tiny_skia_path::Path) -> String {
    let mut out = String::new();
    for seg in path.segments() {
        let _ = match seg {
            PathSegment::MoveTo(p) => write!(out, "M{} {}", p.x, p.y),
            PathSegment::LineTo(p) => write!(out, "L{} {}", p.x, p.y),
            PathSegment::QuadTo(a, p) => write!(out, "Q{} {} {} {}", a.x, a.y, p.x, p.y),
            PathSegment::CubicTo(a, b, p) => write!(out, "C{} {} {} {} {} {}", a.x, a.y, b.x, b.y, p.x, p.y),
            PathSegment::Close => write!(out, "Z"),
        };
    }
    out
}

fn layers(group: &usvg::Group, out: &mut String, prefix: &str) {
    for node in group.children() {
        match node {
            Node::Group(g) => layers(g, out, prefix),
            Node::Path(p) => {
                let ts = p.abs_transform();
                let Some(data) = p.data().clone().transform(ts) else { continue };
                let d = path_data(&data);
                let scale = (ts.sx * ts.sy - ts.kx * ts.ky).abs().sqrt();
                if let Some(fill) = p.fill() {
                    let even_odd = fill.rule() == FillRule::EvenOdd;
                    let _ = write!(out, "{prefix}::Layer {{ ink: {prefix}::Ink::{}, path: \"{d}\", stroke: None, even_odd: {even_odd} }}, ", ink(fill.paint()));
                }
                if let Some(stroke) = p.stroke() {
                    let width = stroke.width().get() * scale;
                    let _ = write!(out, "{prefix}::Layer {{ ink: {prefix}::Ink::{}, path: \"{d}\", stroke: Some({width:?}), even_odd: false }}, ", ink(stroke.paint()));
                }
            }
            Node::Image(_) | Node::Text(_) => {}
        }
    }
}

pub fn engrave(dir: &Path, out: &Path, prefix: &str) -> Result<(), String> {
    println!("cargo:rerun-if-changed={}", dir.display());
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "svg"))
        .collect();
    files.sort();
    let mut code = String::new();
    for file in files {
        let name = file.file_stem().and_then(|s| s.to_str()).ok_or(format!("{}: no name", file.display()))?;
        let svg = std::fs::read_to_string(&file).map_err(|e| format!("{}: {e}", file.display()))?;
        let label = title(&svg).ok_or(format!("{}: every picture needs a <title>, used as its label for screen readers and in the ASCII style", file.display()))?;
        let tree = usvg::Tree::from_str(&svg, &usvg::Options::default()).map_err(|e| format!("{}: {e}", file.display()))?;
        let size = tree.size();
        let mut body = String::new();
        layers(tree.root(), &mut body, prefix);
        let ident: String = name.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_uppercase() } else { '_' }).collect();
        let _ = writeln!(
            code,
            "pub static {ident}: {prefix}::Picture = {prefix}::Picture {{ label: \"{label}\", width: {:?}, height: {:?}, layers: &[{body}] }};",
            size.width(),
            size.height()
        );
    }
    std::fs::write(out, code).map_err(|e| format!("{}: {e}", out.display()))
}
