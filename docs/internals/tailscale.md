# Tailscale

The engine talks to Tailscale only through its command line (`crates/engine/src/tailscale.rs`): the machine's Tailscale name for pairing links, and `tailscale funnel` for publishing I recommend.

## Finding the command

The background engine runs under launchd or systemd, whose `PATH` is minimal (`/usr/bin:/bin:/usr/sbin:/sbin` on macOS). The `tailscale` command usually lives elsewhere: `/usr/local/bin/tailscale` is an optional shim the macOS app installs, Homebrew uses `/opt/homebrew/bin`. So the engine looks on `PATH` first and then in the known install locations, including the app bundle's own binary.

## The macOS app binary needs `SHLVL`

`/Applications/Tailscale.app/Contents/MacOS/Tailscale` is both the GUI and the CLI. It acts as the CLI only when `SHLVL` is set, which a shell always does and launchd never does; without it, it prints "The Tailscale GUI failed to start". The `/usr/local/bin` shim works only because it is a `#!/bin/sh` script. The engine sets `SHLVL=1` on every Tailscale command it runs.

## Funnel never prompts

Every command runs with a 20-second limit and is killed after it. `tailscale funnel` can otherwise wait forever for an interactive confirmation, so it runs with `--yes`. Before publishing, the engine checks that `tailscale status --json` reports the backend running and a `funnel` capability for this machine, so a tailnet without Funnel in its access controls gets a clear message instead of a hang.

## Who is asking

Funnel delivers every public request from loopback, so the public listener can't tell readers apart by their address. Tailscale's proxy sets `X-Forwarded-For` to the client address its Funnel ingress reports (`addProxyForwardedHeaders` in `ipn/ipnlocal/serve.go`), replacing anything the client sent; the listener trusts that header only when the connection comes from loopback. Each client gets its own rate limit, and anyone connecting directly over the network is limited by their address.

## The setting is the intent, Funnel follows it

The publish setting says whether the feed should be public; the Funnel mapping is outside state that can drift from it (a failed `funnel off`, a change made while the engine was stopped). At start a hub with publishing on publishes again, and one with publishing off removes the mapping, but only if Funnel is serving the configured Funnel port to our own public listener, so a user's other `tailscale serve` or `funnel` setups are never touched.

## Requirements and expiry

Funnel needs MagicDNS, HTTPS certificates and the `funnel` node attribute in the tailnet, and on macOS a variant that can proxy a port: the Standalone app (`io.tailscale.ipn.macsys`), the App Store app, or open-source `tailscaled`. Only ports 443, 8443 and 10000 can be public, and a port is either private (`serve`) or public (`funnel`), never both, which is why the default is 10000 rather than 443. Public DNS for a new name can take ten minutes.

The public address is the machine's MagicDNS name, which stays the same unless the machine is renamed or the tailnet's DNS name changes; certificates renew on their own. What does expire is the machine's node key (180 days by default): when it does, the machine drops off the tailnet and the feed goes offline until someone logs in again. Publishing reports the expiry date and says to turn key expiry off for the hub in the admin console.
