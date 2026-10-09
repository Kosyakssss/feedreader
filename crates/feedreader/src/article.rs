use std::ops::Range;

use engine::{Block, Inline, Mode, Request};
use toolkit::images::Images;
use toolkit::images::Slot;
use toolkit::text::{Face, SpanStyle};
use toolkit::ui::{Rect, Scene};

use crate::model::{Geom, Model};
use crate::view::{Hit, Scroll};

struct Prepared {
    spans: Vec<(String, SpanStyle)>,
    links: Vec<(Range<usize>, String)>,
}

fn prepare(inlines: &[Inline], base: SpanStyle) -> Prepared {
    let mut spans: Vec<(String, SpanStyle)> = Vec::new();
    let mut links = Vec::new();
    let mut at = 0;
    for i in inlines {
        let (text, style) = match i {
            Inline::Text(t) => (t.clone(), base),
            Inline::Bold(t) => (t.clone(), SpanStyle { weight: 650, ..base }),
            Inline::Italic(t) => (t.clone(), SpanStyle { italic: true, ..base }),
            Inline::Code(t) => (t.clone(), SpanStyle { face: Face::Mono, color: 2, ..base }),
            Inline::Link(t, url) => {
                links.push((at..at + t.len(), url.clone()));
                (t.clone(), SpanStyle { underline: true, color: 1, ..base })
            }
            Inline::Break => ("\n".to_string(), base),
        };
        at += text.len();
        spans.push((text, style));
    }
    Prepared { spans, links }
}

enum Laid {
    Text {
        p: Prepared,
        size: f32,
        line: f32,
        indent: f32,
        marker: Option<String>,
        quote: bool,
    },
    Code(String),
    Line(String, String, String),
    Picture(String, String, Option<(u32, u32)>),
    Rule,
}

pub struct Header {
    pub title: String,
    pub meta: String,
    pub url: String,
}

#[profiling::function]
pub fn paint(m: &mut Model, s: &mut Scene<Hit>, area: Rect, header: Header) {
    let mt = s.m;
    let (cw, ch) = (mt.cell_w, mt.cell_h);
    let pal = s.palette;
    let mono = mt.mono();
    let images = &mut m.images;
    let out = &mut m.out;
    let Some(r) = m.reader.as_mut() else { return };
    let colors = [pal.ink, pal.link, pal.ink, pal.muted];
    let x0 = area.x + cw;
    let width = (area.w - cw * 5.0).min(cw * m.settings.reading_width as f32).max(cw * 10.0);
    let reading = m.settings.reading_size as f32 / 100.0;
    let blocks: Vec<Block> = match &r.body {
        Some(Ok(b)) => b.clone(),
        _ => Vec::new(),
    };
    let status = match &r.body {
        None if r.mode == Mode::Clean => Some(("Extracting the article\u{2026}".to_string(), pal.faint)),
        None => Some(("Loading\u{2026}".to_string(), pal.faint)),
        Some(Err(e)) => Some((
            format!(
                "{e} {}",
                if r.mode == Mode::Clean {
                    "Try the feed's own text or the original page from the bar below."
                } else {
                    "Try clean or original from the bar below."
                }
            ),
            pal.danger,
        )),
        Some(Ok(_)) => None,
    };
    let body = (mt.size * 1.12 * reading).round();
    let line = (ch * 1.3 * reading).round();
    let base = SpanStyle::plain(Face::Prop);
    let laid: Vec<Laid> = blocks
        .iter()
        .map(|b| match b {
            Block::Paragraph(i) => Laid::Text { p: prepare(i, base), size: body, line, indent: 0.0, marker: None, quote: false },
            Block::Quote(i) => Laid::Text {
                p: prepare(i, SpanStyle { color: 3, ..base }),
                size: body,
                line,
                indent: cw * 2.5,
                marker: None,
                quote: true,
            },
            Block::Item(depth, n, i) => Laid::Text {
                p: prepare(i, base),
                size: body,
                line,
                indent: cw * 3.0 * *depth as f32,
                marker: Some(n.map(|n| format!("{n}.")).unwrap_or_else(|| "\u{2022}".into())),
                quote: false,
            },
            Block::Heading(level, i) => {
                let k = match level {
                    1 => 1.45,
                    2 => 1.3,
                    3 => 1.15,
                    _ => 1.05,
                };
                Laid::Text {
                    p: prepare(i, SpanStyle { weight: 650, ..base }),
                    size: (mt.size * k).round(),
                    line: (mt.size * k * 1.45).round(),
                    indent: 0.0,
                    marker: None,
                    quote: false,
                }
            }
            Block::Code(c) => Laid::Code(c.clone()),
            Block::Image(src, alt, size) => Laid::Picture(src.clone(), alt.clone(), *size),
            Block::Media(src, kind) => {
                let k = if kind.contains("audio") {
                    "audio"
                } else if kind.contains("video") {
                    "video"
                } else {
                    "embed"
                };
                Laid::Line(format!("[{k}] {src}"), src.clone(), k.to_string())
            }
            Block::Rule => Laid::Rule,
        })
        .collect();

    let gap = (line * 0.55).round();
    let title_style = SpanStyle { weight: 650, ..base };
    let title_size = (mt.size * 1.5).round();
    let title_line = (ch * 1.5).round();
    let title_h = s.text.height(&[(header.title.as_str(), title_style)], title_size, title_line, width);
    let head_h = ch * 0.5 + title_h + ch * 3.0;
    let status_h = status.as_ref().map(|(t, _)| s.text.height(&[(t.as_str(), base)], body, line, width) + gap).unwrap_or(0.0);
    let mut heights = Vec::with_capacity(laid.len());
    for l in &laid {
        let h = match l {
            Laid::Text { p, size, line, indent, .. } => {
                let spans: Vec<(&str, SpanStyle)> = p.spans.iter().map(|(t, st)| (t.as_str(), *st)).collect();
                s.text.height(&spans, *size, *line, width - indent).max(*line)
            }
            Laid::Code(c) => {
                let spans = [(c.as_str(), SpanStyle::plain(Face::Mono))];
                s.text.height(&spans, mt.size, ch, width - cw * 2.0) + ch
            }
            Laid::Line(..) => ch,
            Laid::Picture(src, _, hint) => picture_size(picture(images, out, src), *hint, width, mt.scale, ch).1 + ch * 0.5,
            Laid::Rule => ch,
        };
        heights.push(h);
    }
    let note_h = r.note.as_ref().map(|n| s.text.height(&[(n.as_str(), base)], mt.size, ch, width) + ch * 0.5).unwrap_or(0.0);
    let content: f32 = head_h + note_h + status_h + heights.iter().sum::<f32>() + gap * laid.len() as f32 + ch * 2.0;
    r.content_h = content;
    r.view_h = area.h;
    r.scroll = r.scroll.clamp(0.0, (content - area.h).max(0.0));
    let scroll = r.scroll.round();
    let track = Rect::new(area.right() - cw * 2.5, area.y, cw * 2.0, area.h);
    s.hit(area, Hit::Area(Scroll::Reader));
    s.scrollbar(track, scroll, content);
    s.hit(track, Hit::Track(track, Scroll::Reader));
    s.push_clip(Rect::new(area.x, area.y, area.w - cw * 2.5, area.h));
    let mut y = area.y - scroll + ch * 0.5;
    s.spans(&[(header.title.as_str(), title_style)], title_size, title_line, x0, y, Some(width), None, &colors);
    y += title_h;
    s.text(&header.meta, mono, x0, y, Some(width), pal.muted);
    y += ch;
    s.text(&header.url, mono, x0, y, Some(width), pal.faint);
    y += ch;
    s.hline(y, area.x - cw * 0.5, area.right());
    y += ch;
    if let Some(n) = &r.note {
        s.paragraph(n, mt.prop(400.0), ch, x0, y, width, pal.warn);
        y += note_h;
    }
    if let Some((t, c)) = &status {
        s.paragraph(t, mt.prop(400.0), line, x0, y, width, *c);
        y += status_h;
    }
    let ordered = r.ordered();
    let range_for = |block: usize, len: usize| -> Option<std::ops::Range<usize>> {
        let (a, b) = ordered?;
        if block < a.block || block > b.block {
            return None;
        }
        let start = if block == a.block { a.byte } else { 0 };
        let end = if block == b.block { b.byte.min(len) } else { len };
        (start < end).then_some(start..end)
    };
    let mut geom: Vec<Geom> = Vec::new();
    for (l, h) in laid.iter().zip(heights) {
        let visible = y + h >= area.y && y <= area.bottom();
        match l {
            Laid::Text { p, size, line, indent, marker, quote } => {
                let g = Geom { x: x0 + indent, y, w: width - indent, h, size: *size, line: *line, spans: p.spans.clone() };
                if visible {
                    let spans = g.borrowed();
                    if let Some(range) = range_for(geom.len(), g.text().len()) {
                        for rc in s.text.range_rects(&spans, g.size, g.line, g.w, range) {
                            let c = pal.selection;
                            s.fill(Rect::new(g.x + rc[0], g.y + rc[1], rc[2], rc[3]), c);
                        }
                    }
                    if let Some(mk) = marker {
                        let mw = s.measure(mk, mono);
                        s.text(mk, mono, x0 + indent - cw - mw, y + (line - ch) / 2.0, None, pal.muted);
                    }
                    if *quote {
                        s.vline(x0, y, y + h);
                    }
                    let drawn = s.spans(&spans, *size, *line, g.x, y, Some(g.w), None, &colors);
                    for (rect, range) in drawn.underlines {
                        if let Some((_, url)) = p.links.iter().find(|(lr, _)| lr.start <= range.start && range.start < lr.end) {
                            let r = Rect::new(rect[0], rect[1], rect[2], rect[3]);
                            if s.hovered(r) {
                                let t = (mt.scale * 2.0).round().max(2.0);
                                s.fill(Rect::new(r.x, (r.bottom() + t * 0.5).round(), r.w, t), pal.link);
                            }
                            s.hit(r, Hit::Link(url.clone()));
                        }
                    }
                }
                geom.push(g);
            }
            Laid::Code(c) => {
                let g = Geom {
                    x: x0 + cw * 0.5,
                    y: y + ch * 0.25,
                    w: width - cw * 2.0,
                    h: h - ch * 0.5,
                    size: mt.size,
                    line: ch,
                    spans: vec![(c.clone(), SpanStyle::plain(Face::Mono))],
                };
                if visible {
                    s.fill(Rect::new(x0 - cw * 0.5, y, width + cw, h - ch * 0.5), pal.field);
                    let spans = g.borrowed();
                    if let Some(range) = range_for(geom.len(), c.len()) {
                        for rc in s.text.range_rects(&spans, g.size, g.line, g.w, range) {
                            let col = pal.selection;
                            s.fill(Rect::new(g.x + rc[0], g.y + rc[1], rc[2], rc[3]), col);
                        }
                    }
                    s.spans(&spans, mt.size, ch, g.x, g.y, Some(g.w), None, &colors);
                }
                geom.push(g);
            }
            Laid::Line(text, src, kind) => {
                if visible {
                    let st = SpanStyle {
                        underline: true,
                        color: 3,
                        ..SpanStyle::plain(Face::Mono)
                    };
                    let w = s.measure(text, mono).min(width);
                    let r = Rect::new(x0 - cw * 0.5, y, w + cw, ch);
                    s.hover(r);
                    s.spans(&[(text.as_str(), st)], mt.size, ch, x0, y, None, Some(width), &colors);
                    s.hit(r, if kind == "embed" { Hit::Media(src.clone()) } else { Hit::Play(src.clone(), kind.clone()) });
                }
            }
            Laid::Picture(src, alt, hint) => {
                if visible {
                    let slot = images.get(src);
                    let (w, ph) = picture_size(slot, *hint, width, mt.scale, ch);
                    let r = Rect::new(x0, y, w, ph);
                    match slot {
                        Some(Slot::Ready { id, .. }) => s.image(r, id),
                        Some(Slot::Failed) => {
                            let name = if alt.trim().is_empty() { src.rsplit('/').next().unwrap_or(src) } else { alt.as_str() };
                            let text = format!("[image] {name}");
                            let st = SpanStyle { underline: true, color: 3, ..SpanStyle::plain(Face::Mono) };
                            s.spans(&[(text.as_str(), st)], mt.size, ch, x0, y, None, Some(width), &colors);
                        }
                        _ => {
                            s.fill(r, pal.field);
                            s.text("image", mono, x0 + cw, y, None, pal.faint);
                        }
                    }
                    s.hit(r, Hit::Media(src.clone()));
                }
            }
            Laid::Rule => {
                if visible {
                    s.hline(y, x0, x0 + width);
                }
            }
        }
        y += h + gap;
    }
    if status.is_none() && y < area.bottom() {
        s.text("End of the article.", mt.prop(400.0), x0, y, None, pal.faint);
    }
    s.pop_clip();
    r.geom = geom;
}

fn picture(images: &mut Images, out: &mut Vec<Request>, src: &str) -> Option<Slot> {
    let slot = images.get(src);
    if slot.is_none() && images.want(src) {
        out.push(Request::Media(vec![src.to_string()]));
    }
    slot
}

fn picture_size(slot: Option<Slot>, hint: Option<(u32, u32)>, width: f32, scale: f32, ch: f32) -> (f32, f32) {
    let natural = match slot {
        Some(Slot::Ready { width, height, .. }) => Some((width, height)),
        Some(Slot::Failed) => None,
        _ => hint,
    };
    match natural {
        Some((w, h)) if w > 0 && h > 0 => {
            let dw = (w as f32 * scale).min(width).round();
            (dw, (dw * h as f32 / w as f32).round())
        }
        _ if slot == Some(Slot::Failed) => (width, ch),
        _ => (width, ch * 2.0),
    }
}
