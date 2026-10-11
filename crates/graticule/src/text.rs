use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::ops::Range;

use parley::{
    Alignment, AlignmentOptions, FontContext, FontFamily, FontStyle, FontWeight, Layout,
    LayoutContext, LineHeight, PositionedLayoutItem, StyleProperty,
};
use swash::scale::{Render, ScaleContext, Source, StrikeWith};
use swash::zeno::{Format, Vector};

use crate::gpu::{ATLAS, Quad};

const MONO: &[&[u8]] = &[include_bytes!("../assets/fonts/IBMPlexMono-Var.ttf"), include_bytes!("../assets/fonts/IBMPlexMono-VarItalic.ttf")];
const SANS: &[&[u8]] = &[
    include_bytes!("../assets/fonts/IBMPlexSans-Regular.ttf"),
    include_bytes!("../assets/fonts/IBMPlexSans-Italic.ttf"),
    include_bytes!("../assets/fonts/IBMPlexSans-Medium.ttf"),
    include_bytes!("../assets/fonts/IBMPlexSans-SemiBold.ttf"),
    include_bytes!("../assets/fonts/IBMPlexSans-SemiBoldItalic.ttf"),
    include_bytes!("../assets/fonts/IBMPlexSans-Bold.ttf"),
];

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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct SpanStyle {
    pub face: Face,
    pub weight: u16,
    pub italic: bool,
    pub underline: bool,
    pub color: u8,
}

impl SpanStyle {
    pub fn plain(face: Face) -> Self {
        Self {
            face,
            weight: 400,
            italic: false,
            underline: false,
            color: 0,
        }
    }
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

type Run = (parley::FontData, Vec<i16>, [f32; 4], Vec<(GlyphKey, f32, f32)>);

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
    mono: String,
    sans: String,
    layouts_cx: LayoutContext<u8>,
    scale: ScaleContext,
    layouts: HashMap<u64, (Layout<u8>, u64)>,
    glyphs: HashMap<GlyphKey, Option<Slot>>,
    shapes: HashMap<u64, Option<Slot>>,
    shelf: Shelf,
    pub uploads: Vec<Upload>,
    frame: u64,
}

pub struct Drawn {
    pub width: f32,
    pub height: f32,
    pub underlines: Vec<([f32; 4], Range<usize>)>,
}

#[derive(Clone, Copy)]
pub struct Block<'a> {
    pub spans: &'a [(&'a str, SpanStyle)],
    pub size: f32,
    pub line: f32,
    pub wrap: Option<f32>,
}

pub struct Paint<'a> {
    pub origin: (f32, f32),
    pub limit: Option<f32>,
    pub colors: &'a [[f32; 4]],
    pub clip: [f32; 4],
}

impl Default for Text {
    fn default() -> Self {
        Self::new()
    }
}

impl Text {
    pub fn new() -> Self {
        let mut fonts = FontContext::new();
        let mut register = |files: &[&[u8]]| {
            let mut name = String::new();
            for file in files {
                for (family, _) in fonts.collection.register_fonts(parley::fontique::Blob::from(file.to_vec()), None) {
                    if name.is_empty() {
                        name = fonts.collection.family_name(family).unwrap_or_default().to_string();
                    }
                }
            }
            name
        };
        let mono = register(MONO);
        let sans = register(SANS);
        Self {
            fonts,
            mono,
            sans,
            layouts_cx: LayoutContext::new(),
            scale: ScaleContext::new(),
            layouts: HashMap::new(),
            glyphs: HashMap::new(),
            shapes: HashMap::new(),
            shelf: Shelf { x: 0, y: 0, row: 0 },
            uploads: Vec::new(),
            frame: 0,
        }
    }

    pub fn begin_frame(&mut self) {
        self.frame += 1;
        if self.layouts.len() > 8000 {
            let frame = self.frame;
            self.layouts.retain(|_, (_, used)| frame - *used < 120);
        }
    }

    pub fn clear(&mut self) {
        self.layouts.clear();
        self.glyphs.clear();
        self.shapes.clear();
        self.shelf = Shelf { x: 0, y: 0, row: 0 };
    }

    fn layout(&mut self, spans: &[(&str, SpanStyle)], size: f32, line: f32, wrap: Option<f32>) -> &Layout<u8> {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        for (t, s) in spans {
            t.hash(&mut h);
            s.hash(&mut h);
        }
        size.to_bits().hash(&mut h);
        line.to_bits().hash(&mut h);
        wrap.map(|w| w.floor() as u32).hash(&mut h);
        let key = h.finish();
        let frame = self.frame;
        let fonts = &mut self.fonts;
        let cx = &mut self.layouts_cx;
        let (mono, sans) = (self.mono.as_str(), self.sans.as_str());
        let entry = self.layouts.entry(key).or_insert_with(|| {
            profiling::scope!("shape");
            let text: String = spans.iter().map(|(t, _)| *t).collect();
            let mut b = cx.ranged_builder(fonts, &text, 1.0, true);
            b.push_default(StyleProperty::FontFamily(FontFamily::named(sans)));
            b.push_default(StyleProperty::FontSize(size));
            b.push_default(StyleProperty::LineHeight(LineHeight::Absolute(line)));
            let mut at = 0;
            for (t, s) in spans {
                let r = at..at + t.len();
                at = r.end;
                if r.is_empty() {
                    continue;
                }
                b.push(StyleProperty::FontWeight(FontWeight::new(s.weight as f32)), r.clone());
                if s.face == Face::Mono {
                    b.push(StyleProperty::FontFamily(FontFamily::named(mono)), r.clone());
                }
                if s.italic {
                    b.push(StyleProperty::FontStyle(FontStyle::Italic), r.clone());
                }
                if s.underline {
                    b.push(StyleProperty::Underline(true), r.clone());
                }
                b.push(StyleProperty::Brush(s.color), r);
            }
            let mut layout = b.build(&text);
            layout.break_all_lines(wrap);
            layout.align(Alignment::Start, AlignmentOptions::default());
            (layout, frame)
        });
        entry.1 = frame;
        &entry.0
    }

    pub fn measure(&mut self, text: &str, style: TextStyle, line: f32) -> f32 {
        let span = SpanStyle { weight: style.weight as u16, ..SpanStyle::plain(style.face) };
        self.layout(&[(text, span)], style.size, line, None).full_width()
    }

    pub fn index_at(&mut self, text: &str, style: TextStyle, line: f32, x: f32) -> usize {
        let span = SpanStyle { weight: style.weight as u16, ..SpanStyle::plain(style.face) };
        parley::Cursor::from_point(self.layout(&[(text, span)], style.size, line, None), x, 0.0).index()
    }

    pub fn height(&mut self, spans: &[(&str, SpanStyle)], size: f32, line: f32, wrap: f32) -> f32 {
        self.layout(spans, size, line, Some(wrap)).height()
    }

    pub fn byte_at(&mut self, spans: &[(&str, SpanStyle)], size: f32, line: f32, wrap: f32, x: f32, y: f32) -> usize {
        let layout = self.layout(spans, size, line, Some(wrap));
        parley::Cursor::from_point(layout, x, y).index()
    }

    pub fn word_at(&mut self, spans: &[(&str, SpanStyle)], size: f32, line: f32, wrap: f32, x: f32, y: f32) -> Range<usize> {
        let layout = self.layout(spans, size, line, Some(wrap));
        parley::Selection::word_from_point(layout, x, y).text_range()
    }

    pub fn range_rects(&mut self, spans: &[(&str, SpanStyle)], size: f32, line: f32, wrap: f32, range: Range<usize>) -> Vec<[f32; 4]> {
        let layout = self.layout(spans, size, line, Some(wrap));
        let a = parley::Cursor::from_byte_index(layout, range.start, parley::Affinity::Downstream);
        let b = parley::Cursor::from_byte_index(layout, range.end, parley::Affinity::Upstream);
        parley::Selection::new(a, b)
            .geometry(layout)
            .into_iter()
            .map(|(bb, _)| [bb.x0 as f32, bb.y0 as f32, (bb.x1 - bb.x0) as f32, (bb.y1 - bb.y0) as f32])
            .collect()
    }

    #[profiling::function]
    pub fn draw_spans(&mut self, out: &mut Vec<Quad>, block: Block, p: Paint) -> Drawn {
        let Block { spans, size, line, wrap } = block;
        let ellipsis = match p.limit {
            Some(_) => {
                let first = spans.first().map(|s| s.1).unwrap_or(SpanStyle::plain(Face::Prop));
                self.layout(&[("\u{2026}", first)], size, line, None).width()
            }
            None => 0.0,
        };
        let color = |i: u8| p.colors.get(i as usize).copied().unwrap_or(p.colors[0]);
        let mut runs: Vec<Run> = Vec::new();
        let mut underlines = Vec::new();
        let mut rules: Vec<([f32; 4], [f32; 4])> = Vec::new();
        let layout = self.layout(spans, size, line, wrap);
        let (width, height) = (layout.width(), layout.height());
        let cut = p.limit.filter(|l| width > *l).map(|l| l - ellipsis);
        let mut truncated = false;
        let mut end = 0.0f32;
        'lines: for l in layout.lines() {
            for item in l.items() {
                let PositionedLayoutItem::GlyphRun(run) = item else {
                    continue;
                };
                let font = run.run().font().clone();
                let fsize = run.run().font_size();
                let coords = run.run().normalized_coords().to_vec();
                let coords_hash = coords.iter().fold(1469598103934665603u64, |h, c| {
                    (h ^ (*c as u16 as u64)).wrapping_mul(1099511628211)
                });
                let style = run.style();
                let c = color(style.brush);
                if style.underline.is_some() {
                    let m = run.run().metrics();
                    let x = p.origin.0 + run.offset();
                    let y = (p.origin.1 + run.baseline() - m.underline_offset).round();
                    let w = run.advance();
                    let t = m.underline_size.max(1.0).round();
                    rules.push(([x, y, w, t], c));
                    underlines.push(([x, p.origin.1 + run.baseline() - m.ascent, w, m.ascent + m.descent], run.run().text_range()));
                }
                let mut glyphs = Vec::new();
                for glyph in run.positioned_glyphs() {
                    if cut.is_some_and(|c| glyph.x + glyph.advance > c) {
                        truncated = true;
                        runs.push((font, coords, c, glyphs));
                        break 'lines;
                    }
                    end = glyph.x + glyph.advance;
                    let gx = p.origin.0 + glyph.x;
                    let gy = p.origin.1 + glyph.y;
                    let sub = ((gx - gx.floor()) * 4.0).floor() as u8 & 3;
                    let key = GlyphKey {
                        font: font.data.id(),
                        index: font.index,
                        glyph: glyph.id,
                        size: fsize.to_bits(),
                        coords: coords_hash,
                        sub,
                    };
                    glyphs.push((key, gx.floor(), gy.round()));
                }
                runs.push((font, coords, c, glyphs));
            }
        }
        for (r, c) in rules {
            out.push(Quad {
                pos: [r[0], r[1]],
                size: [r[2], r[3]],
                uv: [0.0; 4],
                color: c,
                clip: p.clip,
                kind: 0,
                image: 0,
                pad: [0; 2],
            });
        }
        for (font, coords, c, glyphs) in runs {
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
                        color: c,
                        clip: p.clip,
                        kind: 1,
                        image: 0,
                pad: [0; 2],
                    });
                }
            }
        }
        if truncated {
            let first = spans.first().map(|s| s.1).unwrap_or(SpanStyle::plain(Face::Prop));
            self.draw_spans(
                out,
                Block { spans: &[("\u{2026}", first)], size, line, wrap: None },
                Paint {
                    origin: (p.origin.0 + end, p.origin.1),
                    limit: None,
                    colors: p.colors,
                    clip: p.clip,
                },
            );
        }
        Drawn {
            width: if truncated { end + ellipsis } else { width },
            height,
            underlines,
        }
    }

    #[profiling::function]
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
        self.store(image.placement, image.data)
    }

    fn store(&mut self, placement: swash::zeno::Placement, data: Vec<u8>) -> Option<Slot> {
        let (w, h) = (placement.width, placement.height);
        if w == 0 || h == 0 {
            return None;
        }
        let (x, y) = match self.shelf.alloc(w, h) {
            Some(at) => at,
            None => {
                self.glyphs.clear();
                self.shapes.clear();
                self.shelf = Shelf { x: 0, y: 0, row: 0 };
                self.shelf.alloc(w, h)?
            }
        };
        self.uploads.push(Upload { x, y, w, h, data });
        Some(Slot { x, y, w, h, left: placement.left, top: placement.top })
    }

    pub fn shape(&mut self, out: &mut Vec<Quad>, key: u64, path: &str, stroke: Option<f32>, p: Paint) {
        let slot = match self.shapes.get(&key) {
            Some(slot) => *slot,
            None => {
                let mut mask = swash::zeno::Mask::new(path);
                if let Some(w) = stroke {
                    mask.style(swash::zeno::Stroke::new(w));
                }
                let (data, placement) = mask.render();
                let slot = self.store(placement, data);
                self.shapes.insert(key, slot);
                slot
            }
        };
        if let Some(s) = slot {
            let a = ATLAS as f32;
            out.push(Quad {
                pos: [p.origin.0 + s.left as f32, p.origin.1 + s.top as f32],
                size: [s.w as f32, s.h as f32],
                uv: [s.x as f32 / a, s.y as f32 / a, s.w as f32 / a, s.h as f32 / a],
                color: p.colors.first().copied().unwrap_or([1.0; 4]),
                clip: p.clip,
                kind: 1,
                image: 0,
                pad: [0; 2],
            });
        }
    }
}
