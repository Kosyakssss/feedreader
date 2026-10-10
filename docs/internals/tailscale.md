# Tailscale

The engine talks to Tailscale only through its command line (`crates/engine/src/tailscale.rs`): the machine's Tailscale name for pairing links, and `tailscale funnel` for publishing I recommend.

## Finding the command

The background engine runs under launchd or systemd, whose `PATH` is minimal (`/usr/bin:/bin:/usr/sbin:/sbin` on macOS). The `tailscale` command usually lives elsewhere: `/usr/local/bin/tailscale` is an optional shim the macOS app installs, Homebrew uses `/opt/homebrew/bin`. So the engine looks on `PATH` first and then in the known install locations, including the app bundle's own binary.

## The macOS app binary needs `SHLVL`

`/Applications/Tailscale.app/Contents/MacOS/Tailscale` is both the GUI and the CLI. It acts as the CLI only when `SHLVL` is set, which a shell always does and launchd never does; without it, it prints "The Tailscale GUI failed to start". The `/usr/local/bin` shim works only because it is a `#!/bin/sh` script. The engine sets `SHLVL=1` on every Tailscale command it runs.

## Funnel never prompts

Every command runs with a 20-second limit and is killed after it. `tailscale funnel` can otherwise wait forever for an interactive confirmation, so it runs with `--yes`. Before publishing, the engine checks that `tailscale status --json` reports the backend running and a `funnel` capability for this machine, so a tailnet without Funnel in its access controls gets a clear message instead of a hang.
