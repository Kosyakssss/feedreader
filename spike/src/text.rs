use std::collections::HashMap;

use parley::{
    Alignment, AlignmentOptions, FontContext, FontFamily, FontVariations, FontWeight, Layout,
    LayoutContext, LineHeight, PositionedLayoutItem, StyleProperty,
};
use swash::scale::{Render, ScaleContext, Source, StrikeWith};
use swash::zeno::{Format, Vector};

use crate::gpu::{ATLAS, Quad};

const FONT: &[u8] = include_bytes!("../assets/fonts/GoogleSansCode.ttf");
const FAMILY: &str = "Google Sans Code";

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Face {
    Mono,
    Prop,
}

#[derive(Clone, Copy, Debug)]
pub struct TextStyle {
    pub face: Face,
    pub size: f32,
    pub weight: f32,
}

#[derive(Hash, PartialEq, Eq)]
struct LayoutKey {
    text: String,
    face: Face,
    size: u32,
    weight: u32,
    line: u32,
    wrap: Option<u32>,
}

#[derive(Hash, PartialEq, Eq, Clone, Copy)]
struct GlyphKey {
    font: u64,
    index: u32,
    glyph: u32,
    size: u32,
    coords: u64,
    sub: u8,
}

#[derive(Clone, Copy)]
struct Slot {
    x: u32,
    y: u32,
    w: u32,
    h: u32,
    left: i32,
    top: i32,
}

pub struct Upload {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
    pub data: Vec<u8>,
}

struct Shelf {
    x: u32,
    y: u32,
    row: u32,
}

impl Shelf {
    fn alloc(&mut self, w: u32, h: u32) -> Option<(u32, u32)> {
        if self.x + w + 1 > ATLAS {
            self.x = 0;
            self.y += self.row + 1;
            self.row = 0;
        }
        if self.y + h + 1 > ATLAS {
            return None;
        }
        let at = (self.x, self.y);
        self.x += w + 1;
        self.row = self.row.max(h);
        Some(at)
    }
}

pub struct Text {
    fonts: FontContext,
    layouts_cx: LayoutContext<()>,
    scale: ScaleContext,
    layouts: HashMap<LayoutKey, (Layout<()>, u64)>,
    glyphs: HashMap<GlyphKey, Option<Slot>>,
    shelf: Shelf,
    pub uploads: Vec<Upload>,
    frame: u64,
}

pub struct Drawn {
    pub width: f32,
    pub height: f32,
}

impl Text {
    pub fn new() -> Self {
        let mut fonts = FontContext::new();
        fonts
            .collection
            .register_fonts(parley::fontique::Blob::from(FONT.to_vec()), None);
        Self {
            fonts,
            layouts_cx: LayoutContext::new(),
            scale: ScaleContext::new(),
            layouts: HashMap::new(),
            glyphs: HashMap::new(),
            shelf: Shelf { x: 0, y: 0, row: 0 },
            uploads: Vec::new(),
            frame: 0,
        }
    }

    pub fn begin_frame(&mut self) {
        self.frame += 1;
        if self.layouts.len() > 6000 {
            let frame = self.frame;
            self.layouts.retain(|_, (_, used)| frame - *used < 120);
        }
    }

    pub fn clear(&mut self) {
        self.layouts.clear();
        self.glyphs.clear();
        self.shelf = Shelf { x: 0, y: 0, row: 0 };
    }

    fn layout(
        &mut self,
        text: &str,
        style: TextStyle,
        line: f32,
        wrap: Option<f32>,
    ) -> &Layout<()> {
        let key = LayoutKey {
            text: text.to_owned(),
            face: style.face,
            size: style.size.to_bits(),
            weight: style.weight.to_bits(),
            line: line.to_bits(),
            wrap: wrap.map(|w| w.floor() as u32),
        };
        let frame = self.frame;
        let entry = self.layouts.entry(key).or_insert_with(|| {
            let mut builder = self.layouts_cx.ranged_builder(&mut self.fonts, text, 1.0, true);
            builder.push_default(StyleProperty::FontFamily(FontFamily::named(FAMILY)));
            builder.push_default(StyleProperty::FontSize(style.size));
            builder.push_default(StyleProperty::FontWeight(FontWeight::new(style.weight)));
            builder.push_default(StyleProperty::FontVariations(FontVariations::from(
                match style.face {
                    Face::Mono => "\"MONO\" 1",
                    Face::Prop => "\"MONO\" 0",
                },
            )));
            builder.push_default(StyleProperty::LineHeight(LineHeight::Absolute(line)));
            let mut layout = builder.build(text);
            layout.break_all_lines(wrap);
            layout.align(Alignment::Start, AlignmentOptions::default());
            (layout, frame)
        });
        entry.1 = frame;
        &entry.0
    }

    pub fn measure(&mut self, text: &str, style: TextStyle, line: f32) -> f32 {
        self.layout(text, style, line, None).width()
    }

    pub fn draw(
        &mut self,
        out: &mut Vec<Quad>,
        text: &str,
        style: TextStyle,
        line: f32,
        origin: (f32, f32),
        limit: Option<f32>,
        wrap: Option<f32>,
        color: [f32; 4],
        clip: [f32; 4],
    ) -> Drawn {
        let ellipsis = match limit {
            Some(_) => self.measure("\u{2026}", style, line),
            None => 0.0,
        };
        let mut runs: Vec<(parley::FontData, Vec<i16>, Vec<(GlyphKey, f32, f32)>)> = Vec::new();
        let layout = self.layout(text, style, line, wrap);
        let (width, height) = (layout.width(), layout.height());
        let cut = limit.filter(|l| width > *l).map(|l| l - ellipsis);
        let mut truncated = false;
        let mut end = 0.0f32;
        'lines: for line in layout.lines() {
            for item in line.items() {
                let PositionedLayoutItem::GlyphRun(run) = item else {
                    continue;
                };
                let font = run.run().font().clone();
                let size = run.run().font_size();
                let coords = run.run().normalized_coords().to_vec();
                let coords_hash = coords.iter().fold(1469598103934665603u64, |h, c| {
                    (h ^ (*c as u16 as u64)).wrapping_mul(1099511628211)
                });
                let mut glyphs = Vec::new();
                for glyph in run.positioned_glyphs() {
                    if cut.is_some_and(|c| glyph.x + glyph.advance > c) {
                        truncated = true;
                        runs.push((font, coords, glyphs));
                        break 'lines;
                    }
                    let gx = origin.0 + glyph.x;
                    let gy = origin.1 + glyph.y;
                    let sub = ((gx - gx.floor()) * 4.0).floor() as u8 & 3;
                    let key = GlyphKey {
                        font: font.data.id(),
                        index: font.index,
                        glyph: glyph.id,
                        size: size.to_bits(),
                        coords: coords_hash,
                        sub,
                    };
                    end = glyph.x + glyph.advance;
                    glyphs.push((key, gx.floor(), gy.round()));
                }
                runs.push((font, coords, glyphs));
            }
        }
        for (font, coords, glyphs) in runs {
            for (key, x, y) in glyphs {
                let slot = match self.glyphs.get(&key) {
                    Some(slot) => *slot,
                    None => {
                        let slot = self.rasterize(key, &font, &coords);
                        self.glyphs.insert(key, slot);
                        slot
                    }
                };
                if let Some(s) = slot {
                    let a = ATLAS as f32;
                    out.push(Quad {
                        pos: [x + s.left as f32, y - s.top as f32],
                        size: [s.w as f32, s.h as f32],
                        uv: [s.x as f32 / a, s.y as f32 / a, s.w as f32 / a, s.h as f32 / a],
                        color,
                        clip,
                        kind: 1,
                        pad: [0; 3],
                    });
                }
            }
        }
        if truncated {
            self.draw(out, "\u{2026}", style, line, (origin.0 + end, origin.1), None, None, color, clip);
        }
        Drawn {
            width: if truncated { end + ellipsis } else { width },
            height,
        }
    }

    fn rasterize(&mut self, key: GlyphKey, font: &parley::FontData, coords: &[i16]) -> Option<Slot> {
        let font_ref = swash::FontRef::from_index(font.data.data(), font.index as usize)?;
        let mut scaler = self
            .scale
            .builder(font_ref)
            .size(f32::from_bits(key.size))
            .hint(false)
            .normalized_coords(coords.iter())
            .build();
        let image = Render::new(&[Source::Outline, Source::Bitmap(StrikeWith::BestFit)])
            .format(Format::Alpha)
            .offset(Vector::new(key.sub as f32 / 4.0, 0.0))
            .render(&mut scaler, key.glyph as u16)?;
        let (w, h) = (image.placement.width, image.placement.height);
        if w == 0 || h == 0 {
            return None;
        }
        let (x, y) = match self.shelf.alloc(w, h) {
            Some(at) => at,
            None => {
                self.glyphs.clear();
                self.shelf = Shelf { x: 0, y: 0, row: 0 };
                self.shelf.alloc(w, h)?
            }
        };
        self.uploads.push(Upload {
            x,
            y,
            w,
            h,
            data: image.data,
        });
        Some(Slot {
            x,
            y,
            w,
            h,
            left: image.placement.left,
            top: image.placement.top,
        })
    }
}
