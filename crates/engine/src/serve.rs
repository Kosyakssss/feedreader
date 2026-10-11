use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::net::UnixListener;
use tokio::sync::broadcast;

use crate::types::{Audience, Client, Event, Request};
use crate::{Handle, Link};

pub fn socket_path(dir: &Path) -> PathBuf {
    dir.join("engine.sock")
}

pub fn running(dir: &Path) -> bool {
    UnixStream::connect(socket_path(dir)).is_ok()
}

fn info_path(dir: &Path) -> PathBuf {
    dir.join("engine.json")
}

pub fn protocol(dir: &Path) -> Option<u32> {
    let bytes = std::fs::read(info_path(dir)).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    v.get("protocol")?.as_u64().map(|p| p as u32)
}

pub fn stop(dir: &Path) {
    let Ok(mut stream) = UnixStream::connect(socket_path(dir)) else { return };
    if stream.write_all(b"\"Shutdown\"\n").is_err() {
        return;
    }
    drop(stream);
    for _ in 0..100 {
        if !running(dir) {
            return;
        }
        std::thread::sleep(Duration::from_millis(30));
    }
}

type Line = Arc<(Audience, String)>;

pub fn serve(dir: PathBuf) -> Result<(), String> {
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = socket_path(&dir);
    if running(&dir) {
        return Err(format!("An engine is already running for {}", dir.display()));
    }
    let (events, _) = broadcast::channel::<Line>(8192);
    let sender = events.clone();
    let (handle, runtime, stopped) = crate::launch(dir.clone(), move |e, to| {
        if let Ok(line) = serde_json::to_string(&e) {
            let _ = sender.send(Arc::new((to, line)));
        }
    })?;
    runtime.block_on(async move {
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).map_err(|e| e.to_string())?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
        let info = serde_json::json!({ "protocol": crate::PROTOCOL, "version": env!("CARGO_PKG_VERSION"), "pid": std::process::id() });
        std::fs::write(info_path(&dir), info.to_string()).map_err(|e| e.to_string())?;
        eprintln!("feedreader engine listening on {}", path.display());
        tokio::select! {
            r = accept(listener, events, Arc::new(handle)) => r,
            r = stopped => r.map_err(|_| "The engine stopped unexpectedly".to_string()),
        }
    })
}

async fn accept(listener: UnixListener, events: broadcast::Sender<Line>, handle: Arc<Handle>) -> Result<(), String> {
    let mut next: Client = 0;
    loop {
        let (sock, _) = listener.accept().await.map_err(|e| e.to_string())?;
        next += 1;
        let me = next;
        let (read, mut write) = sock.into_split();
        let mut rx = events.subscribe();
        tokio::spawn(async move {
            while let Ok(line) = rx.recv().await {
                let (to, text) = &*line;
                if matches!(to, Audience::Client(c) if *c != me) {
                    continue;
                }
                if write.write_all(text.as_bytes()).await.is_err() || write.write_all(b"\n").await.is_err() {
                    break;
                }
            }
            let _ = write.shutdown().await;
        });
        let handle = handle.clone();
        tokio::spawn(async move {
            handle.send_as(me, Request::Resync);
            let mut lines = tokio::io::BufReader::new(read).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                match serde_json::from_str::<Request>(&line) {
                    Ok(r) => handle.send_as(me, r),
                    Err(e) => eprintln!("bad request: {e}"),
                }
            }
            handle.send_as(me, Request::Detach);
        });
    }
}

pub fn connect(dir: &Path, emit: Arc<dyn Fn(Event) + Send + Sync>) -> Option<Handle> {
    let stream = UnixStream::connect(socket_path(dir)).ok()?;
    let mut writer = stream.try_clone().ok()?;
    let (tx, rx) = std::sync::mpsc::channel::<Request>();
    let writer = std::thread::Builder::new()
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
    Some(Handle { link: Link::Socket(tx, writer) })
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
