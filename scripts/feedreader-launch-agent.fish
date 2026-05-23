#!/usr/bin/env fish

set -g label org.sk.feedreader
set -g script_dir (dirname (status --current-filename))
set -g project_dir (cd "$script_dir/.."; and pwd)
set -g plist "$HOME/Library/LaunchAgents/$label.plist"
set -g log_dir "$HOME/Library/Logs/feedreader"
set -g bun_bin (command -v bun)
set -g uid (id -u)
set -g domain "gui/$uid"
set -g service "$domain/$label"

if test -z "$bun_bin"
    set bun_bin /Users/kote/.bun/bin/bun
end

function usage
    echo "Usage: scripts/feedreader-launch-agent.fish install|uninstall|start|stop|restart|status|plist"
end

function current_port
    set -l port 8787
    set -l config "$project_dir/data/config.json"
    if test -f "$config"; and command -q jq
        set -l configured (jq -r 'if type == "object" and (.port | type == "number") then .port else empty end' "$config" 2>/dev/null)
        if test -n "$configured"
            set port "$configured"
        end
    end
    echo "$port"
end

function write_plist
    mkdir -p (dirname "$plist") "$log_dir"
    set -l tmp (mktemp "$TMPDIR/feedreader-launch-agent.XXXXXX")

    printf '%s\n' \
        '<?xml version="1.0" encoding="UTF-8"?>' \
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
        '<plist version="1.0">' \
        '<dict>' \
        '  <key>Label</key>' \
        "  <string>$label</string>" \
        '  <key>ProgramArguments</key>' \
        '  <array>' \
        "    <string>$bun_bin</string>" \
        "    <string>$project_dir/server.ts</string>" \
        '  </array>' \
        '  <key>WorkingDirectory</key>' \
        "  <string>$project_dir</string>" \
        '  <key>RunAtLoad</key>' \
        '  <true/>' \
        '  <key>ProcessType</key>' \
        '  <string>Background</string>' \
        '  <key>StandardOutPath</key>' \
        "  <string>$log_dir/stdout.log</string>" \
        '  <key>StandardErrorPath</key>' \
        "  <string>$log_dir/stderr.log</string>" \
        '  <key>EnvironmentVariables</key>' \
        '  <dict>' \
        '    <key>PATH</key>' \
        '    <string>/Users/kote/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>' \
        '  </dict>' \
        '</dict>' \
        '</plist>' >"$tmp"

    mv -f "$tmp" "$plist"
    plutil -lint "$plist" >/dev/null
end

function is_loaded
    launchctl print "$service" >/dev/null 2>&1
end

function show_status
    if is_loaded
        echo "loaded: $service"
        launchctl print "$service" | string match --regex --entire '^\tstate =.*|^\tpid =.*|^\tlast exit code =.*'
    else
        echo "not loaded: $service"
    end

    set -l port (current_port)
    if command -q curl
        set -l health_url "http://127.0.0.1:$port/api/health"
        set -l health (curl --fail --silent "$health_url" 2>/dev/null)
        if test $status -eq 0
            echo "health: $health"
        else
            echo "health: no response from $health_url"
        end
    end
end

function stop_agent
    if is_loaded
        launchctl bootout "$domain" "$plist"
    end
end

set -l cmd "$argv[1]"
if test -z "$cmd"
    set cmd status
end

switch "$cmd"
    case install
        write_plist; or exit 1
        stop_agent >/dev/null 2>&1
        launchctl bootstrap "$domain" "$plist"; or exit 1
        launchctl enable "$service"
        sleep 1
        show_status
    case uninstall
        stop_agent >/dev/null 2>&1
        rm -f "$plist"
        echo "removed: $plist"
    case start
        if not test -f "$plist"
            write_plist; or exit 1
        end
        if not is_loaded
            launchctl bootstrap "$domain" "$plist"; or exit 1
        else
            launchctl kickstart -k "$service"; or exit 1
        end
        launchctl enable "$service"
        sleep 1
        show_status
    case stop
        stop_agent
        show_status
    case restart
        if not test -f "$plist"
            write_plist; or exit 1
        end
        stop_agent >/dev/null 2>&1
        launchctl bootstrap "$domain" "$plist"; or exit 1
        launchctl enable "$service"
        sleep 1
        show_status
    case status
        show_status
    case plist
        write_plist; or exit 1
        echo "$plist"
    case '*'
        usage
        exit 2
end
