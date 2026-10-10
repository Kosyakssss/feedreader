use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};

pub struct Decoded {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Slot {
    Pending,
    Ready { id: u32, width: u32, height: u32 },
    Failed,
}

struct Ready {
    id: u32,
    bytes: usize,
    used: u64,
}

pub struct Images {
    slots: HashMap<String, Slot>,
    ready: HashMap<String, Ready>,
    jobs: Sender<(String, PathBuf)>,
    done: Receiver<(String, Result<Decoded, String>)>,
    uploads: Vec<(u32, Decoded)>,
    evicted: Vec<u32>,
    next: u32,
    frame: u64,
    budget: usize,
}

const MAX_SIDE: u32 = 2048;

#[profiling::function]
fn decode(path: &PathBuf) -> Result<Decoded, String> {
    let img = image::ImageReader::open(path)
        .map_err(|e| e.to_string())?
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .decode()
        .map_err(|e| e.to_string())?;
    let img = if img.width() > MAX_SIDE || img.height() > MAX_SIDE {
        img.resize(MAX_SIDE, MAX_SIDE, image::imageops::FilterType::Triangle)
    } else {
        img
    };
    let rgba = img.to_rgba8();
    Ok(Decoded {
        width: rgba.width(),
        height: rgba.height(),
        rgba: rgba.into_raw(),
    })
}

impl Images {
    pub fn new(wake: impl Fn() + Send + Sync + 'static) -> Self {
        let (jobs, rx) = channel::<(String, PathBuf)>();
        let (tx, done) = channel();
        let rx = Arc::new(Mutex::new(rx));
        let wake = Arc::new(wake);
        for n in 0..2 {
            let rx = rx.clone();
            let tx = tx.clone();
            let wake = wake.clone();
            std::thread::Builder::new()
                .name(format!("decode-{n}"))
                .spawn(move || {
                    profiling::register_thread!();
                    loop {
                        let job = rx.lock().unwrap().recv();
                        let Ok((key, path)) = job else { return };
                        if tx.send((key, decode(&path))).is_err() {
                            return;
                        }
                        wake();
                    }
                })
                .expect("decode thread");
        }
        Self {
            slots: HashMap::new(),
            ready: HashMap::new(),
            jobs,
            done,
            uploads: Vec::new(),
            evicted: Vec::new(),
            next: 1,
            frame: 0,
            budget: 256 * 1024 * 1024,
        }
    }

    pub fn get(&mut self, key: &str) -> Option<Slot> {
        let slot = self.slots.get(key).copied();
        if let Some(r) = self.ready.get_mut(key) {
            r.used = self.frame;
        }
        slot
    }

    pub fn want(&mut self, key: &str) -> bool {
        if self.slots.contains_key(key) {
            return false;
        }
        self.slots.insert(key.to_string(), Slot::Pending);
        true
    }

    pub fn load(&mut self, key: String, path: PathBuf) {
        self.slots.insert(key.clone(), Slot::Pending);
        let _ = self.jobs.send((key, path));
    }

    pub fn fail(&mut self, key: String) {
        self.slots.insert(key, Slot::Failed);
    }

    pub fn begin_frame(&mut self) {
        self.frame += 1;
        while let Ok((key, r)) = self.done.try_recv() {
            match r {
                Ok(d) => {
                    let id = self.next;
                    self.next += 1;
                    self.slots.insert(key.clone(), Slot::Ready { id, width: d.width, height: d.height });
                    self.ready.insert(key, Ready { id, bytes: d.rgba.len(), used: self.frame });
                    self.uploads.push((id, d));
                }
                Err(_) => {
                    self.slots.insert(key, Slot::Failed);
                }
            }
        }
        let mut total: usize = self.ready.values().map(|r| r.bytes).sum();
        if total > self.budget {
            let mut old: Vec<(String, u64)> = self.ready.iter().filter(|(_, r)| r.used + 1 < self.frame).map(|(k, r)| (k.clone(), r.used)).collect();
            old.sort_by_key(|(_, used)| *used);
            for (key, _) in old {
                if total <= self.budget {
                    break;
                }
                if let Some(r) = self.ready.remove(&key) {
                    total -= r.bytes;
                    self.evicted.push(r.id);
                    self.slots.remove(&key);
                }
            }
        }
    }

    pub fn pending(&self) -> usize {
        self.slots.values().filter(|s| matches!(s, Slot::Pending)).count()
    }

    pub fn take_uploads(&mut self) -> Vec<(u32, Decoded)> {
        std::mem::take(&mut self.uploads)
    }

    pub fn take_evicted(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.evicted)
    }
}
