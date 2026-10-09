use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::net::UnixListener;
use tokio::sync::broadcast;

use crate::types::{Event, Request};
use crate::{Handle, Link};

pub fn socket_path(dir: &Path) -> PathBuf {
    dir.join("engine.sock")
}

pub fn running(dir: &Path) -> bool {
    UnixStream::connect(socket_path(dir)).is_ok()
}

pub fn serve(dir: PathBuf) -> Result<(), String> {
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = socket_path(&dir);
    if running(&dir) {
        return Err(format!("An engine is already running for {}", dir.display()));
    }
    let (events, _) = broadcast::channel::<Arc<String>>(8192);
    let sender = events.clone();
    let handle = crate::start(dir.clone(), move |e| {
        if let Ok(line) = serde_json::to_string(&e) {
            let _ = sender.send(Arc::new(line));
        }
    })?;
    let handle = Arc::new(handle);
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    rt.block_on(async move {
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).map_err(|e| e.to_string())?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
        eprintln!("feedreader engine listening on {}", path.display());
        loop {
            let (sock, _) = listener.accept().await.map_err(|e| e.to_string())?;
            let (read, mut write) = sock.into_split();
            let mut rx = events.subscribe();
            let handle = handle.clone();
            tokio::spawn(async move {
                loop {
                    match rx.recv().await {
                        Ok(line) => {
                            if write.write_all(line.as_bytes()).await.is_err() || write.write_all(b"\n").await.is_err() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                let _ = write.shutdown().await;
            });
            tokio::spawn(async move {
                handle.send(Request::Resync);
                let mut lines = tokio::io::BufReader::new(read).lines();
                let mut extractor = false;
                while let Ok(Some(line)) = lines.next_line().await {
                    match serde_json::from_str::<Request>(&line) {
                        Ok(r) => {
                            if matches!(r, Request::UseWebExtractor) {
                                extractor = true;
                            }
                            handle.send(r);
                        }
                        Err(e) => eprintln!("bad request: {e}"),
                    }
                }
                handle.send(Request::Detach { extractor });
            });
        }
    })
}

pub fn connect(dir: &Path, emit: Arc<dyn Fn(Event) + Send + Sync>) -> Option<Handle> {
    let stream = UnixStream::connect(socket_path(dir)).ok()?;
    let mut writer = stream.try_clone().ok()?;
    let (tx, rx) = std::sync::mpsc::channel::<Request>();
    std::thread::Builder::new()
        .name("engine-out".into())
        .spawn(move || {
            for r in rx {
                let Ok(line) = serde_json::to_string(&r) else { continue };
                if writer.write_all(line.as_bytes()).is_err() || writer.write_all(b"\n").is_err() {
                    break;
                }
            }
        })
        .ok()?;
    std::thread::Builder::new()
        .name("engine-in".into())
        .spawn(move || {
            let reader = BufReader::with_capacity(1 << 20, stream);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if let Ok(e) = serde_json::from_str::<Event>(&line) {
                    emit(e);
                }
            }
            emit(Event::Disconnected);
        })
        .ok()?;
    Some(Handle { link: Link::Socket(tx) })
}

pub fn spawn_background(dir: &Path) -> bool {
    let Ok(exe) = std::env::current_exe() else { return false };
    let log = crate::log_dir();
    let _ = std::fs::create_dir_all(&log);
    let out = std::fs::OpenOptions::new().create(true).append(true).open(log.join("engine.log"));
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("serve").env("FEEDREADER_HOME", dir).stdin(std::process::Stdio::null());
    if let Ok(f) = out {
        if let Ok(f2) = f.try_clone() {
            cmd.stdout(f2);
        }
        cmd.stderr(f);
    }
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    if cmd.spawn().is_err() {
        return false;
    }
    for _ in 0..100 {
        if running(dir) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    false
}
