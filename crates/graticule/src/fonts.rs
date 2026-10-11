use std::collections::HashMap;
use std::sync::Arc;

use parley::FontContext;
use parley::fontique::{Blob, Collection, CollectionOptions, FallbackKey, FamilyId, Script};

pub const MONO: [&[u8]; 2] = [include_bytes!("../assets/fonts/IBMPlexMono-Var.ttf"), include_bytes!("../assets/fonts/IBMPlexMono-VarItalic.ttf")];

pub const SANS: [&[u8]; 6] = [
    include_bytes!("../assets/fonts/IBMPlexSans-Regular.ttf"),
    include_bytes!("../assets/fonts/IBMPlexSans-Italic.ttf"),
    include_bytes!("../assets/fonts/IBMPlexSans-Medium.ttf"),
    include_bytes!("../assets/fonts/IBMPlexSans-SemiBold.ttf"),
    include_bytes!("../assets/fonts/IBMPlexSans-SemiBoldItalic.ttf"),
    include_bytes!("../assets/fonts/IBMPlexSans-Bold.ttf"),
];

pub struct Family {
    pub name: &'static str,
    pub scripts: &'static [[u8; 4]],
    pub ranges: &'static [(u32, u32)],
    pub files: &'static [&'static [u8]],
}

pub const EXTRA: [Family; 5] = [
    Family {
        name: "IBM Plex Sans Arabic",
        scripts: &[*b"Arab"],
        ranges: &[(0x0600, 0x06FF), (0x0750, 0x077F), (0x0870, 0x08FF), (0xFB50, 0xFDFF), (0xFE70, 0xFEFF)],
        files: &[include_bytes!("../assets/fonts/IBMPlexSansArabic-Regular.ttf"), include_bytes!("../assets/fonts/IBMPlexSansArabic-Medium.ttf"), include_bytes!("../assets/fonts/IBMPlexSansArabic-SemiBold.ttf"), include_bytes!("../assets/fonts/IBMPlexSansArabic-Bold.ttf")],
    },
    Family {
        name: "IBM Plex Sans Devanagari",
        scripts: &[*b"Deva"],
        ranges: &[(0x0900, 0x097F), (0x1CD0, 0x1CFF), (0xA8E0, 0xA8FF)],
        files: &[include_bytes!("../assets/fonts/IBMPlexSansDevanagari-Regular.ttf"), include_bytes!("../assets/fonts/IBMPlexSansDevanagari-Medium.ttf"), include_bytes!("../assets/fonts/IBMPlexSansDevanagari-SemiBold.ttf"), include_bytes!("../assets/fonts/IBMPlexSansDevanagari-Bold.ttf")],
    },
    Family {
        name: "IBM Plex Sans Hebrew",
        scripts: &[*b"Hebr"],
        ranges: &[(0x0590, 0x05FF), (0xFB1D, 0xFB4F)],
        files: &[include_bytes!("../assets/fonts/IBMPlexSansHebrew-Regular.ttf"), include_bytes!("../assets/fonts/IBMPlexSansHebrew-Medium.ttf"), include_bytes!("../assets/fonts/IBMPlexSansHebrew-SemiBold.ttf"), include_bytes!("../assets/fonts/IBMPlexSansHebrew-Bold.ttf")],
    },
    Family {
        name: "IBM Plex Sans Thai",
        scripts: &[*b"Thai"],
        ranges: &[(0x0E00, 0x0E7F)],
        files: &[include_bytes!("../assets/fonts/IBMPlexSansThai-Regular.ttf"), include_bytes!("../assets/fonts/IBMPlexSansThai-Medium.ttf"), include_bytes!("../assets/fonts/IBMPlexSansThai-SemiBold.ttf"), include_bytes!("../assets/fonts/IBMPlexSansThai-Bold.ttf")],
    },
    Family {
        name: "IBM Plex Math",
        scripts: &[*b"Latn", *b"Cyrl", *b"Grek", *b"Zyyy", *b"Zmth"],
        ranges: &[(0x2100, 0x214F), (0x2190, 0x23FF), (0x25A0, 0x25FF), (0x27C0, 0x2AFF), (0x1D400, 0x1D7FF)],
        files: &[include_bytes!("../assets/fonts/IBMPlexMath-Regular.ttf")],
    },
];

#[derive(Clone, Copy)]
enum Cover {
    Core,
    Extra(usize),
    Missing,
}

fn maps(file: &[u8], c: char) -> bool {
    swash::FontRef::from_index(file, 0).is_some_and(|f| f.charmap().map(c) != 0)
}

pub struct Fonts {
    pub cx: FontContext,
    pub mono: String,
    pub sans: String,
    loaded: [bool; EXTRA.len()],
    covered: HashMap<char, Cover>,
}

impl Fonts {
    pub fn new(system_fonts: bool) -> Self {
        let mut cx = FontContext { collection: Collection::new(CollectionOptions { shared: false, system_fonts }), source_cache: Default::default() };
        let mono = register(&mut cx, &MONO).1;
        let sans = register(&mut cx, &SANS).1;
        Self { cx, mono, sans, loaded: [false; EXTRA.len()], covered: HashMap::new() }
    }

    pub fn loaded(&self) -> [bool; EXTRA.len()] {
        self.loaded
    }

    pub fn with_system(loaded: [bool; EXTRA.len()]) -> Self {
        let mut fonts = Self::new(true);
        for (i, loaded) in loaded.iter().enumerate() {
            if *loaded {
                fonts.load(i);
            }
        }
        fonts
    }

    fn cover(&mut self, c: char) -> Cover {
        *self.covered.entry(c).or_insert_with(|| {
            if maps(MONO[0], c) || maps(SANS[0], c) {
                return Cover::Core;
            }
            let code = c as u32;
            EXTRA
                .iter()
                .position(|f| f.ranges.iter().any(|(a, b)| (*a..=*b).contains(&code)) && maps(f.files[0], c))
                .map_or(Cover::Missing, Cover::Extra)
        })
    }

    fn load(&mut self, i: usize) {
        if self.loaded[i] {
            return;
        }
        self.loaded[i] = true;
        let family = &EXTRA[i];
        let (ids, _) = register(&mut self.cx, family.files);
        for script in family.scripts {
            let key = FallbackKey::new(Script::from_bytes(*script), None);
            let rest: Vec<FamilyId> = self.cx.collection.fallback_families(key).filter(|id| !ids.contains(id)).collect();
            self.cx.collection.set_fallbacks(key, ids.iter().copied().chain(rest));
        }
    }

    pub fn prepare(&mut self, text: &str) -> bool {
        let mut complete = true;
        for c in text.chars() {
            if c.is_ascii() || crate::chars::drawn(c) {
                continue;
            }
            match self.cover(c) {
                Cover::Core => {}
                Cover::Extra(i) => self.load(i),
                Cover::Missing => complete = false,
            }
        }
        complete
    }
}

fn register(cx: &mut FontContext, files: &[&'static [u8]]) -> (Vec<FamilyId>, String) {
    let mut ids = Vec::new();
    let mut name = String::new();
    for file in files {
        for (family, _) in cx.collection.register_fonts(Blob::new(Arc::new(*file)), None) {
            if !ids.contains(&family) {
                ids.push(family);
            }
            if name.is_empty() {
                name = cx.collection.family_name(family).unwrap_or_default().to_string();
            }
        }
    }
    (ids, name)
}
