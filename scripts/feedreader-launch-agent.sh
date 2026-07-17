#!/bin/sh
set -eu

label='org.sk.feedreader'
script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd -P)
project_dir=$(CDPATH= cd "$script_dir/.." && pwd -P)
plist="$HOME/Library/LaunchAgents/$label.plist"
log_dir="$HOME/Library/Logs/feedreader"
uid=$(id -u)
domain="gui/$uid"
service="$domain/$label"
launch_path="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

usage() {
    echo "Usage: scripts/feedreader-launch-agent.sh install|uninstall|start|stop|restart|status|plist"
}

find_bun() {
    if command -v bun >/dev/null 2>&1; then
        command -v bun
    elif [ -x "$HOME/.bun/bin/bun" ]; then
        printf '%s\n' "$HOME/.bun/bin/bun"
    else
        echo 'bun is not installed or not on PATH' >&2
        return 1
    fi
}

xml_escape() {
    printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

current_port() {
    port=8787
    config="$project_dir/data/config.json"
    if [ -f "$config" ] && command -v jq >/dev/null 2>&1; then
        configured=$(jq -r 'if type == "object" and (.port | type == "number") then .port else empty end' "$config" 2>/dev/null || true)
        [ -z "$configured" ] || port=$configured
    fi
    printf '%s\n' "$port"
}

tailscale_target() {
    printf 'http://127.0.0.1:%s\n' "$(current_port)"
}

start_tailscale_serve() {
    if ! command -v tailscale >/dev/null 2>&1; then
        echo 'tailscale: not installed; skipping Serve'
        return 0
    fi

    target=$(tailscale_target)
    if tailscale serve --bg --set-path /feedreader "$target" >/dev/null; then
        echo "tailscale serve: /feedreader -> $target"
    else
        echo "tailscale serve: failed to serve $target" >&2
    fi
}

stop_tailscale_serve() {
    command -v tailscale >/dev/null 2>&1 || return 0
    target=$(tailscale_target)
    status_text=$(tailscale serve status 2>/dev/null || true)
    printf '%s\n' "$status_text" | grep -F "$target" >/dev/null 2>&1 || return 0

    proxy_count=$(printf '%s\n' "$status_text" | grep -c ' proxy ' || true)
    if [ "$proxy_count" -eq 1 ]; then
        tailscale serve reset >/dev/null
        echo 'tailscale serve: reset feedreader Serve config'
    else
        echo 'tailscale serve: other served paths exist; leaving Serve config intact'
    fi
}

write_plist() {
    bun_bin=$(find_bun) || return 1
    mkdir -p "$(dirname "$plist")" "$log_dir"
    tmp=$(mktemp "${TMPDIR:-/tmp}/feedreader-launch-agent.XXXXXX")
    trap 'rm -f "$tmp"' EXIT HUP INT TERM

    bun_xml=$(xml_escape "$bun_bin")
    server_xml=$(xml_escape "$project_dir/server.ts")
    project_xml=$(xml_escape "$project_dir")
    stdout_xml=$(xml_escape "$log_dir/stdout.log")
    stderr_xml=$(xml_escape "$log_dir/stderr.log")
    path_xml=$(xml_escape "$launch_path")

    cat >"$tmp" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$bun_xml</string>
    <string>$server_xml</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$project_xml</string>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$stdout_xml</string>
  <key>StandardErrorPath</key>
  <string>$stderr_xml</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$path_xml</string>
  </dict>
</dict>
</plist>
EOF

    plutil -lint "$tmp" >/dev/null
    mv -f "$tmp" "$plist"
    trap - EXIT HUP INT TERM
}

is_loaded() {
    launchctl print "$service" >/dev/null 2>&1
}

show_status() {
    if is_loaded; then
        echo "loaded: $service"
        launchctl print "$service" | grep -E '^[[:space:]]*(state|pid|last exit code) =' || true
    else
        echo "not loaded: $service"
    fi

    if command -v curl >/dev/null 2>&1; then
        health_url="http://127.0.0.1:$(current_port)/api/health"
        if health=$(curl --fail --silent "$health_url" 2>/dev/null); then
            echo "health: $health"
        else
            echo "health: no response from $health_url"
        fi
    fi

    if command -v tailscale >/dev/null 2>&1; then
        echo 'tailscale serve:'
        tailscale serve status 2>/dev/null || echo '  unavailable'
    fi
}

stop_agent() {
    if is_loaded; then
        launchctl bootout "$domain" "$plist"
    fi
}

cmd=${1:-status}
case "$cmd" in
    install|restart)
        write_plist
        stop_agent >/dev/null 2>&1 || true
        launchctl bootstrap "$domain" "$plist"
        launchctl enable "$service"
        start_tailscale_serve
        sleep 1
        show_status
        ;;
    uninstall)
        stop_tailscale_serve
        stop_agent >/dev/null 2>&1 || true
        rm -f "$plist"
        echo "removed: $plist"
        ;;
    start)
        [ -f "$plist" ] || write_plist
        if is_loaded; then
            launchctl kickstart -k "$service"
        else
            launchctl bootstrap "$domain" "$plist"
        fi
        launchctl enable "$service"
        start_tailscale_serve
        sleep 1
        show_status
        ;;
    stop)
        stop_tailscale_serve
        stop_agent
        show_status
        ;;
    status)
        show_status
        ;;
    plist)
        write_plist
        echo "$plist"
        ;;
    *)
        usage
        exit 2
        ;;
esac
