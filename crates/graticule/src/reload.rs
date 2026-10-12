use std::path::PathBuf;
use std::process::Command;

use winit::dpi::{PhysicalPosition, PhysicalSize};
use winit::window::Window;

use crate::state::State;

pub(crate) struct Reload {
    handoff: PathBuf,
    exe: PathBuf,
}

pub(crate) struct Handoff {
    pub frame: Option<(PhysicalPosition<i32>, PhysicalSize<u32>)>,
    pub state: State,
    pub app: String,
}

impl Reload {
    pub fn from_env() -> Option<Self> {
        let handoff = PathBuf::from(std::env::var_os("GRATICULE_RELOAD")?);
        let exe = std::env::current_exe().ok()?;
        Some(Self { handoff, exe })
    }

    pub fn listen(&self, reload: impl Fn() + Send + 'static) {
        std::thread::spawn(move || {
            for _ in std::io::stdin().lines().map_while(Result::ok) {
                reload();
            }
        });
    }

    pub fn take(&self) -> Option<Handoff> {
        let text = std::fs::read_to_string(&self.handoff).ok()?;
        let _ = std::fs::remove_file(&self.handoff);
        let mut lines = text.lines();
        let mut handoff = Handoff { frame: None, state: State::default(), app: String::new() };
        for line in lines.by_ref().take_while(|l| !l.is_empty()) {
            match line.split_once(' ') {
                Some(("frame", frame)) => {
                    let n: Vec<i64> = frame.split(' ').filter_map(|n| n.parse().ok()).collect();
                    if let [x, y, w, h] = n[..] {
                        handoff.frame = Some((PhysicalPosition::new(x as i32, y as i32), PhysicalSize::new(w as u32, h as u32)));
                    }
                }
                Some(("scroll", scroll)) => handoff.state.restore(scroll),
                _ => {}
            }
        }
        handoff.app = lines.collect::<Vec<_>>().join("\n");
        Some(handoff)
    }

    pub fn save(&self, window: &Window, state: &State, app: &str) -> Result<(), String> {
        let mut out = String::new();
        if let Ok(p) = window.inner_position() {
            let size = window.inner_size();
            out.push_str(&format!("frame {} {} {} {}\n", p.x, p.y, size.width, size.height));
        }
        state.keep(&mut out);
        out.push('\n');
        out.push_str(app);
        std::fs::write(&self.handoff, out).map_err(|e| format!("{}: {e}", self.handoff.display()))
    }

    pub fn relaunch(&self) -> Result<(), String> {
        let mut command = Command::new(&self.exe);
        command.args(std::env::args_os().skip(1));
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            Err(format!("{}: {}", self.exe.display(), command.exec()))
        }
        #[cfg(not(unix))]
        command.spawn().map(drop).map_err(|e| format!("{}: {e}", self.exe.display()))
    }
}
