use std::path::{Path, PathBuf};

use graticule::ui::{DARK, LIGHT, Palette};

const NAMES: &[&str] = &["bg", "ink", "muted", "faint", "rule", "cursor", "hover", "selection", "field", "link", "danger", "warn"];

fn slot<'a>(p: &'a mut Palette, name: &str) -> Option<&'a mut [f32; 4]> {
    Some(match name {
        "bg" => &mut p.bg,
        "ink" => &mut p.ink,
        "muted" => &mut p.muted,
        "faint" => &mut p.faint,
        "rule" => &mut p.rule,
        "cursor" => &mut p.cursor,
        "hover" => &mut p.hover,
        "selection" => &mut p.selection,
        "field" => &mut p.field,
        "link" => &mut p.link,
        "danger" => &mut p.danger,
        "warn" => &mut p.warn,
        _ => return None,
    })
}

fn hex(c: [f32; 4]) -> String {
    format!("#{:02x}{:02x}{:02x}", (c[0] * 255.0).round() as u8, (c[1] * 255.0).round() as u8, (c[2] * 255.0).round() as u8)
}

fn color(s: &str) -> Option<[f32; 4]> {
    let s = s.strip_prefix('#')?;
    if s.len() != 6 {
        return None;
    }
    let v = u32::from_str_radix(s, 16).ok()?;
    let ch = |shift: u32| ((v >> shift) & 0xff) as f32 / 255.0;
    Some([ch(16), ch(8), ch(0), 1.0])
}

pub struct Theme {
    pub light: Palette,
    pub dark: Palette,
    pub path: PathBuf,
}

impl Theme {
    pub fn new(dir: &Path) -> Self {
        Self {
            light: LIGHT,
            dark: DARK,
            path: dir.join("theme.toml"),
        }
    }

    pub fn reload(&mut self) -> Result<bool, String> {
        let text = match std::fs::read_to_string(&self.path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let changed = self.light.bg != LIGHT.bg || self.dark.bg != DARK.bg;
                self.light = LIGHT;
                self.dark = DARK;
                return Ok(changed);
            }
            Err(e) => return Err(e.to_string()),
        };
        let good = self.path.with_extension("last-good.toml");
        let (light, dark) = match parse(&text) {
            Ok(p) => {
                let _ = std::fs::write(&good, &text);
                p
            }
            Err(e) => {
                if self.light == LIGHT
                    && self.dark == DARK
                    && let Some(p) = std::fs::read_to_string(&good).ok().and_then(|t| parse(&t).ok())
                {
                    self.light = p.0;
                    self.dark = p.1;
                }
                return Err(e);
            }
        };
        self.light = light;
        self.dark = dark;
        Ok(true)
    }

    pub fn template(&self) -> String {
        let mut s = String::from("# Feedreader theme. Colors are #rrggbb. Save to apply; a broken file is ignored and the last good one stays.\n");
        for (name, mut p) in [("light", self.light), ("dark", self.dark)] {
            s.push_str(&format!("\n[{name}]\n"));
            for n in NAMES {
                let c = *slot(&mut p, n).expect("known name");
                s.push_str(&format!("{n} = \"{}\"\n", hex(c)));
            }
        }
        s
    }
}

fn parse(text: &str) -> Result<(Palette, Palette), String> {
    let table: toml::Table = text.parse().map_err(|e: toml::de::Error| format!("theme.toml: {}", e.message()))?;
    let mut out = (LIGHT, DARK);
    for (key, value) in &table {
        let target = match key.as_str() {
            "light" => &mut out.0,
            "dark" => &mut out.1,
            other => return Err(format!("theme.toml: unknown section [{other}]; use [light] and [dark]")),
        };
        let section = value.as_table().ok_or_else(|| format!("theme.toml: {key} must be a section"))?;
        for (name, v) in section {
            let s = v.as_str().ok_or_else(|| format!("theme.toml: {key}.{name} must be a \"#rrggbb\" string"))?;
            let c = color(s).ok_or_else(|| format!("theme.toml: {key}.{name} = \"{s}\" isn't a #rrggbb color"))?;
            *slot(target, name).ok_or_else(|| format!("theme.toml: unknown color {key}.{name}"))? = c;
        }
    }
    Ok(out)
}
