use std::path::PathBuf;
use std::process::Command;

const LABEL: &str = "app.feedreader.engine";

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn home() -> Result<PathBuf, String> {
    std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| "HOME isn't set".to_string())
}

fn plist_path() -> Result<PathBuf, String> {
    Ok(home()?.join("Library/LaunchAgents").join(format!("{LABEL}.plist")))
}

fn unit_path() -> Result<PathBuf, String> {
    let base = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).map(Ok).unwrap_or_else(|| home().map(|h| h.join(".config")))?;
    Ok(base.join("systemd/user/feedreader.service"))
}

fn uid() -> String {
    Command::new("id").arg("-u").output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default()
}

pub fn install() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = exe.canonicalize().unwrap_or(exe);
    let logs = engine::log_dir();
    std::fs::create_dir_all(&logs).map_err(|e| e.to_string())?;
    if cfg!(target_os = "macos") {
        let path = plist_path()?;
        let env = match std::env::var_os("FEEDREADER_HOME") {
            Some(h) => format!(
                "<key>EnvironmentVariables</key><dict><key>FEEDREADER_HOME</key><string>{}</string></dict>",
                esc(&h.to_string_lossy())
            ),
            None => String::new(),
        };
        let plist = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n<key>Label</key><string>{LABEL}</string>\n<key>ProgramArguments</key><array><string>{}</string><string>serve</string></array>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ProcessType</key><string>Background</string>\n{env}\n<key>StandardOutPath</key><string>{}</string>\n<key>StandardErrorPath</key><string>{}</string>\n</dict></plist>\n",
            esc(&exe.to_string_lossy()),
            esc(&logs.join("engine.log").to_string_lossy()),
            esc(&logs.join("engine.log").to_string_lossy()),
        );
        std::fs::create_dir_all(path.parent().unwrap_or(&path)).map_err(|e| e.to_string())?;
        let domain = format!("gui/{}", uid());
        let _ = Command::new("launchctl").args(["bootout", &format!("{domain}/{LABEL}")]).output();
        std::fs::write(&path, plist).map_err(|e| e.to_string())?;
        let out = Command::new("launchctl").args(["bootstrap", &domain]).arg(&path).output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(format!("launchctl refused the agent: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        Ok(format!("Installed {} and started the engine. It runs at login and restarts if it crashes.", path.display()))
    } else {
        let path = unit_path()?;
        let env = std::env::var_os("FEEDREADER_HOME")
            .map(|h| format!("Environment=FEEDREADER_HOME={}\n", h.to_string_lossy()))
            .unwrap_or_default();
        let unit = format!(
            "[Unit]\nDescription=Feedreader engine\n\n[Service]\nExecStart={} serve\n{env}Restart=on-failure\n\n[Install]\nWantedBy=default.target\n",
            exe.display()
        );
        std::fs::create_dir_all(path.parent().unwrap_or(&path)).map_err(|e| e.to_string())?;
        std::fs::write(&path, unit).map_err(|e| e.to_string())?;
        let ok = Command::new("systemctl").args(["--user", "daemon-reload"]).status().is_ok_and(|s| s.success())
            && Command::new("systemctl").args(["--user", "enable", "--now", "feedreader.service"]).status().is_ok_and(|s| s.success());
        if !ok {
            return Err("systemctl --user couldn't enable feedreader.service".into());
        }
        Ok(format!("Installed {} and started the engine.", path.display()))
    }
}

pub fn uninstall() -> Result<String, String> {
    if cfg!(target_os = "macos") {
        let path = plist_path()?;
        let _ = Command::new("launchctl").args(["bootout", &format!("gui/{}/{LABEL}", uid())]).output();
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
        Ok("Removed the engine's login item and stopped it.".into())
    } else {
        let _ = Command::new("systemctl").args(["--user", "disable", "--now", "feedreader.service"]).status();
        let path = unit_path()?;
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
        Ok("Removed the engine's systemd unit and stopped it.".into())
    }
}
