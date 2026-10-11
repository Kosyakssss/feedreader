use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::images::Images;
use crate::shell::Offscreen;
use crate::specimen::{Sandbox, Sheet};
use crate::ui::{DARK, LIGHT, LineStyle};

pub const ROWS: i32 = 40;
const SCALE: f32 = 2.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Variant {
    pub lines: LineStyle,
    pub dark: bool,
    pub cols: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Missing,
    Same,
    Changed(usize),
}

pub struct Render {
    pub pixels: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub ms: f32,
}

pub struct Proofs {
    dir: PathBuf,
    screen: Option<Offscreen>,
    status: HashMap<(usize, Variant), Status>,
}

pub fn lines_name(s: LineStyle) -> &'static str {
    match s {
        LineStyle::Ascii => "ascii",
        LineStyle::Light => "light",
        LineStyle::Heavy => "heavy",
        LineStyle::Double => "double",
        LineStyle::Dotted => "dotted",
    }
}

fn slug(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect()
}

pub fn file_name(sheet: &Sheet, v: Variant) -> String {
    format!(
        "{}--{}--{}--{}--{}.png",
        slug(sheet.group),
        slug(sheet.name),
        lines_name(v.lines),
        if v.dark { "dark" } else { "light" },
        v.cols
    )
}

pub fn write_png(path: &Path, r: &Render) -> Result<(), String> {
    let file = std::fs::File::create(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut enc = png::Encoder::new(std::io::BufWriter::new(file), r.width, r.height);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header().and_then(|mut w| w.write_image_data(&r.pixels)).map_err(|e| e.to_string())
}

fn read_png(path: &Path) -> Option<(Vec<u8>, u32, u32)> {
    let decoder = png::Decoder::new(std::io::BufReader::new(std::fs::File::open(path).ok()?));
    let mut reader = decoder.read_info().ok()?;
    let mut buf = vec![0; reader.output_buffer_size()?];
    let info = reader.next_frame(&mut buf).ok()?;
    buf.truncate(info.buffer_size());
    (info.color_type == png::ColorType::Rgba).then_some((buf, info.width, info.height))
}

impl Proofs {
    pub fn new(app: &str) -> Self {
        let dir = match std::env::var_os("GRATICULE_PROOFS") {
            Some(d) => PathBuf::from(d),
            None => dirs::data_dir().unwrap_or_else(std::env::temp_dir).join("Graticule").join("Specimen").join(slug(app)),
        };
        Self { dir, screen: None, status: HashMap::new() }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn render(&mut self, sheet: &Sheet, v: Variant) -> Render {
        let screen = self.screen.get_or_insert_with(|| Offscreen::new(64, 64, SCALE, 13.0));
        let (cw, ch) = (screen.metrics.cell_w, screen.metrics.cell_h);
        screen.resize((v.cols as f32 * cw) as u32, (ROWS as f32 * ch) as u32);
        let palette = if v.dark { DARK } else { LIGHT };
        let sandbox = Sandbox::default();
        let mut images = Images::new(|| {});
        let (quads, ms) = screen.paint(v.lines, palette, None, |s| {
            let area = s.screen();
            (sheet.paint)(s, area, &sandbox);
        });
        let pixels = screen.capture(&quads, palette.bg, &mut images);
        let (width, height) = screen.size();
        Render { pixels, width, height, ms }
    }

    pub fn status(&self, sheet: usize, v: Variant) -> Option<Status> {
        self.status.get(&(sheet, v)).copied()
    }

    pub fn check(&mut self, index: usize, sheet: &Sheet, v: Variant) -> Status {
        if let Some(s) = self.status(index, v) {
            return s;
        }
        let path = self.dir.join(file_name(sheet, v));
        let status = match read_png(&path) {
            None => Status::Missing,
            Some((proof, w, h)) => {
                let now = self.render(sheet, v);
                if (w, h) != (now.width, now.height) {
                    Status::Changed((now.width * now.height) as usize)
                } else {
                    let changed = proof.as_chunks::<4>().0.iter().zip(now.pixels.as_chunks::<4>().0).filter(|(a, b)| a != b).count();
                    if changed == 0 {
                        Status::Same
                    } else {
                        let diff = diff(&proof, &now);
                        let _ = write_png(&self.dir.join(format!("{}.diff.png", file_name(sheet, v))), &diff);
                        Status::Changed(changed)
                    }
                }
            }
        };
        self.status.insert((index, v), status);
        status
    }

    pub fn approve(&mut self, index: usize, sheet: &Sheet, v: Variant) -> Result<PathBuf, String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| format!("{}: {e}", self.dir.display()))?;
        let render = self.render(sheet, v);
        let path = self.dir.join(file_name(sheet, v));
        write_png(&path, &render)?;
        let _ = std::fs::remove_file(self.dir.join(format!("{}.diff.png", file_name(sheet, v))));
        self.status.insert((index, v), Status::Same);
        Ok(path)
    }

    pub fn diff_path(&self, sheet: &Sheet, v: Variant) -> PathBuf {
        self.dir.join(format!("{}.diff.png", file_name(sheet, v)))
    }
}

fn diff(proof: &[u8], now: &Render) -> Render {
    let mut pixels = Vec::with_capacity(now.pixels.len());
    for (a, b) in proof.as_chunks::<4>().0.iter().zip(now.pixels.as_chunks::<4>().0) {
        if a == b {
            pixels.extend(b[..3].iter().map(|c| 255 - (255 - c) / 4));
            pixels.push(255);
        } else {
            pixels.extend([230, 40, 40, 255]);
        }
    }
    Render { pixels, width: now.width, height: now.height, ms: 0.0 }
}
