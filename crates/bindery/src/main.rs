use std::path::{Path, PathBuf};
use std::process::Command;

const USAGE: &str = "BD-01 BINDERY: builds, installs and updates Graticule apps

  bindery install [PATH or GIT URL] [-p PACKAGE] [--to DIR]
  bindery bundle [PATH] [-p PACKAGE]
  bindery list
  bindery check
  bindery update [NAME]
  bindery remove NAME
  bindery service install | uninstall

An app describes itself in its Cargo.toml:

  [package.metadata.graticule]
  name = \"Feedreader\"
  id = \"app.feedreader\"
  command = \"feedreader\"
  category = \"public.app-category.news\"
";

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
enum Source {
    Path(PathBuf),
    Git(String),
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
struct Installed {
    name: String,
    id: String,
    package: String,
    version: String,
    commit: Option<String>,
    source: Source,
    app: PathBuf,
    command: Option<PathBuf>,
    update: Option<String>,
    checked: Option<i64>,
}

struct Manifest {
    package: String,
    version: String,
    name: String,
    id: String,
    command: Option<String>,
    category: String,
    minimum_macos: String,
    root: PathBuf,
    target: PathBuf,
}

fn home() -> Result<PathBuf, String> {
    dirs::data_dir().map(|d| d.join("Graticule").join("Bindery")).ok_or("no data folder on this system".into())
}

fn registry() -> Result<Vec<Installed>, String> {
    let path = home()?.join("apps.json");
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

fn save(apps: &[Installed]) -> Result<(), String> {
    let dir = home()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let path = dir.join("apps.json");
    let text = serde_json::to_vec_pretty(apps).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("{}: {e}", path.display()))
}

fn run(cmd: &mut Command) -> Result<String, String> {
    let shown = format!("{cmd:?}");
    let out = cmd.output().map_err(|e| format!("{shown}: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(format!("{shown} failed: {}", String::from_utf8_lossy(&out.stderr).trim()))
    }
}

fn manifest(root: &Path, package: Option<&str>) -> Result<Manifest, String> {
    let out = run(Command::new("cargo").args(["metadata", "--no-deps", "--format-version", "1", "--manifest-path"]).arg(root.join("Cargo.toml")))?;
    let meta: serde_json::Value = serde_json::from_str(&out).map_err(|e| e.to_string())?;
    let packages = meta["packages"].as_array().ok_or("cargo metadata listed no packages")?;
    let pkg = packages
        .iter()
        .find(|p| match package {
            Some(name) => p["name"] == name,
            None => p["metadata"]["graticule"].is_object(),
        })
        .ok_or_else(|| match package {
            Some(name) => format!("no package named {name} in {}", root.display()),
            None => format!("no package in {} has [package.metadata.graticule]", root.display()),
        })?;
    let g = &pkg["metadata"]["graticule"];
    let text = |key: &str| g[key].as_str().map(str::to_string);
    let package = pkg["name"].as_str().unwrap_or_default().to_string();
    Ok(Manifest {
        name: text("name").unwrap_or_else(|| package.clone()),
        id: text("id").ok_or(format!("{package}: [package.metadata.graticule] needs an id, like app.example"))?,
        command: text("command"),
        category: text("category").unwrap_or_else(|| "public.app-category.utilities".into()),
        minimum_macos: text("minimum_macos").unwrap_or_else(|| "12.0".into()),
        version: pkg["version"].as_str().unwrap_or("0.0.0").to_string(),
        package,
        root: root.to_path_buf(),
        target: PathBuf::from(meta["target_directory"].as_str().unwrap_or("target")),
    })
}

fn plist(m: &Manifest, executable: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>{name}</string>
  <key>CFBundleDisplayName</key><string>{name}</string>
  <key>CFBundleIdentifier</key><string>{id}</string>
  <key>CFBundleExecutable</key><string>{executable}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>{version}</string>
  <key>CFBundleVersion</key><string>{version}</string>
  <key>LSMinimumSystemVersion</key><string>{min}</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSApplicationCategoryType</key><string>{category}</string>
</dict>
</plist>
"#,
        name = m.name,
        id = m.id,
        version = m.version,
        min = m.minimum_macos,
        category = m.category,
    )
}

fn bundle(m: &Manifest) -> Result<PathBuf, String> {
    if !cfg!(target_os = "macos") {
        return Err("Bindery bundles macOS apps for now; Linux and Windows come later".into());
    }
    println!("building {} {} in release mode", m.package, m.version);
    run(Command::new("cargo").args(["build", "--release", "-p", &m.package, "--manifest-path"]).arg(m.root.join("Cargo.toml")))?;
    let app = m.target.join(format!("{}.app", m.name));
    let _ = std::fs::remove_dir_all(&app);
    let macos = app.join("Contents").join("MacOS");
    std::fs::create_dir_all(&macos).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(app.join("Contents").join("Resources")).map_err(|e| e.to_string())?;
    std::fs::copy(m.target.join("release").join(&m.package), macos.join(&m.package)).map_err(|e| format!("copying the binary: {e}"))?;
    std::fs::write(app.join("Contents").join("Info.plist"), plist(m, &m.package)).map_err(|e| e.to_string())?;
    if let Err(e) = run(Command::new("codesign").args(["--force", "--sign", "-"]).arg(&app)) {
        eprintln!("not signed: {e}");
    }
    Ok(app)
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    run(Command::new("cp").arg("-R").arg(from).arg(to)).map(|_| ())
}

fn commit(root: &Path) -> Option<String> {
    run(Command::new("git").arg("-C").arg(root).args(["rev-parse", "--short", "HEAD"])).ok()
}

fn install_from(source: Source, package: Option<&str>, to: Option<PathBuf>) -> Result<Installed, String> {
    let root = match &source {
        Source::Path(p) => p.canonicalize().map_err(|e| format!("{}: {e}", p.display()))?,
        Source::Git(url) => {
            let name = url.trim_end_matches('/').trim_end_matches(".git").rsplit('/').next().unwrap_or("app").to_string();
            let dir = home()?.join("sources").join(name);
            if dir.join(".git").is_dir() {
                run(Command::new("git").arg("-C").arg(&dir).args(["pull", "--ff-only", "--quiet"]))?;
            } else {
                std::fs::create_dir_all(dir.parent().unwrap_or(&dir)).map_err(|e| e.to_string())?;
                run(Command::new("git").args(["clone", "--quiet", url]).arg(&dir))?;
            }
            dir
        }
    };
    let m = manifest(&root, package)?;
    let built = bundle(&m)?;
    let dest_dir = to.unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join("Applications"));
    std::fs::create_dir_all(&dest_dir).map_err(|e| format!("{}: {e}", dest_dir.display()))?;
    let dest = dest_dir.join(format!("{}.app", m.name));
    let _ = std::fs::remove_dir_all(&dest);
    copy_dir(&built, &dest)?;
    let command = match &m.command {
        Some(cmd) => {
            let bin = dirs::home_dir().unwrap_or_default().join(".local").join("bin");
            std::fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
            let link = bin.join(cmd);
            let _ = std::fs::remove_file(&link);
            std::os::unix::fs::symlink(dest.join("Contents").join("MacOS").join(&m.package), &link).map_err(|e| format!("{}: {e}", link.display()))?;
            Some(link)
        }
        None => None,
    };
    Ok(Installed {
        name: m.name,
        id: m.id,
        package: m.package,
        version: m.version,
        commit: commit(&root),
        source: match source {
            Source::Path(_) => Source::Path(root),
            git => git,
        },
        app: dest,
        command,
        update: None,
        checked: None,
    })
}

fn record(app: Installed) -> Result<(), String> {
    let mut apps = registry()?;
    apps.retain(|a| a.id != app.id);
    println!(
        "installed {} {} at {}{}",
        app.name,
        app.version,
        app.app.display(),
        app.command.as_ref().map(|c| format!(", command {}", c.display())).unwrap_or_default()
    );
    apps.push(app);
    save(&apps)
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

fn check() -> Result<(), String> {
    let mut apps = registry()?;
    for app in &mut apps {
        let root = match &app.source {
            Source::Path(p) => p.clone(),
            Source::Git(url) => home()?.join("sources").join(url.trim_end_matches('/').trim_end_matches(".git").rsplit('/').next().unwrap_or("app")),
        };
        app.update = match &app.source {
            Source::Git(_) => {
                run(Command::new("git").arg("-C").arg(&root).args(["fetch", "--quiet"]))?;
                let ahead = run(Command::new("git").arg("-C").arg(&root).args(["rev-list", "--count", "HEAD..@{u}"]))?;
                (ahead != "0").then(|| format!("{ahead} new commits"))
            }
            Source::Path(_) => {
                let m = manifest(&root, Some(&app.package))?;
                let now = commit(&root);
                if m.version != app.version {
                    Some(format!("version {}", m.version))
                } else if now.is_some() && now != app.commit {
                    Some(format!("commit {}", now.unwrap_or_default()))
                } else {
                    None
                }
            }
        };
        app.checked = Some(now());
        println!("{}: {}", app.name, app.update.as_deref().unwrap_or("up to date"));
    }
    save(&apps)
}

fn list() -> Result<(), String> {
    let apps = registry()?;
    if apps.is_empty() {
        println!("nothing installed through Bindery yet");
    }
    for a in apps {
        let source = match &a.source {
            Source::Path(p) => p.display().to_string(),
            Source::Git(url) => url.clone(),
        };
        println!(
            "{:<16} {:<8} {:<9} {}  {}",
            a.name,
            a.version,
            a.commit.as_deref().unwrap_or("-"),
            a.update.as_deref().map(|u| format!("update: {u}")).unwrap_or_else(|| "up to date".into()),
            source
        );
    }
    Ok(())
}

fn update(name: Option<&str>) -> Result<(), String> {
    for app in registry()?.into_iter().filter(|a| name.is_none_or(|n| a.name.eq_ignore_ascii_case(n) || a.id == n)) {
        let to = app.app.parent().map(Path::to_path_buf);
        if let Source::Path(p) = &app.source
            && p.join(".git").is_dir()
        {
            let _ = run(Command::new("git").arg("-C").arg(p).args(["pull", "--ff-only", "--quiet"]));
        }
        record(install_from(app.source.clone(), Some(&app.package), to)?)?;
    }
    Ok(())
}

fn remove(name: &str) -> Result<(), String> {
    let mut apps = registry()?;
    let Some(i) = apps.iter().position(|a| a.name.eq_ignore_ascii_case(name) || a.id == name) else {
        return Err(format!("{name} isn't installed through Bindery"));
    };
    let app = apps.remove(i);
    let _ = std::fs::remove_dir_all(&app.app);
    if let Some(c) = &app.command {
        let _ = std::fs::remove_file(c);
    }
    println!("removed {} from {}", app.name, app.app.display());
    save(&apps)
}

const AGENT: &str = "app.graticule.bindery.check";

fn service(install: bool) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("the background check runs under launchd on macOS for now".into());
    }
    let plist = dirs::home_dir().unwrap_or_default().join("Library/LaunchAgents").join(format!("{AGENT}.plist"));
    let domain = format!("gui/{}", run(Command::new("id").arg("-u"))?);
    let _ = run(Command::new("launchctl").args(["bootout", &format!("{domain}/{AGENT}")]));
    if !install {
        let _ = std::fs::remove_file(&plist);
        println!("Bindery no longer checks for updates in the background");
        return Ok(());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let log = dirs::home_dir().unwrap_or_default().join("Library/Logs/bindery.log");
    let text = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{AGENT}</string>
  <key>ProgramArguments</key><array><string>{}</string><string>check</string></array>
  <key>StartInterval</key><integer>86400</integer>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>{}</string></dict>
  <key>StandardOutPath</key><string>{}</string>
  <key>StandardErrorPath</key><string>{}</string>
</dict>
</plist>
"#,
        exe.display(),
        std::env::var("PATH").unwrap_or_default(),
        log.display(),
        log.display()
    );
    std::fs::create_dir_all(plist.parent().unwrap_or(Path::new("."))).map_err(|e| e.to_string())?;
    std::fs::write(&plist, text).map_err(|e| e.to_string())?;
    run(Command::new("launchctl").args(["bootstrap", &domain]).arg(&plist))?;
    println!("Bindery checks for updates once a day and records them; `bindery list` shows them");
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let positional: Vec<&String> = {
        let mut out = Vec::new();
        let mut skip = false;
        for a in args.iter().skip(1) {
            if skip {
                skip = false;
            } else if a == "-p" || a == "--to" {
                skip = true;
            } else {
                out.push(a);
            }
        }
        out
    };
    let package = flag("-p");
    let result = match args.first().map(String::as_str) {
        Some("install") => {
            let target = positional.first().map(|s| s.to_string()).unwrap_or_else(|| ".".into());
            let source = if target.contains("://") || target.starts_with("git@") { Source::Git(target) } else { Source::Path(PathBuf::from(target)) };
            install_from(source, package.as_deref(), flag("--to").map(PathBuf::from)).and_then(record)
        }
        Some("bundle") => {
            let root = PathBuf::from(positional.first().map(|s| s.as_str()).unwrap_or("."));
            manifest(&root, package.as_deref()).and_then(|m| bundle(&m)).map(|app| println!("{}", app.display()))
        }
        Some("list") => list(),
        Some("check") => check(),
        Some("update") => update(positional.first().map(|s| s.as_str())),
        Some("remove") => match positional.first() {
            Some(name) => remove(name),
            None => Err("which app? `bindery list` shows them".into()),
        },
        Some("service") => match positional.first().map(|s| s.as_str()) {
            Some("install") => service(true),
            Some("uninstall") => service(false),
            _ => Err("bindery service install | uninstall".into()),
        },
        _ => {
            print!("{USAGE}");
            Ok(())
        }
    };
    if let Err(e) = result {
        eprintln!("bindery: {e}");
        std::process::exit(1);
    }
}
