# Security

## Threat model

Wranglr's daemon is designed to run on a trusted local network only (your home
or office Wi-Fi). It has no built-in NAT traversal or public relay — the PWA
must be on the same network as the daemon to reach it.

- **Auth:** a single 256-bit token, generated on first run and persisted at
  `~/.config/wranglr/token` (mode 0600), gates every HTTP and WebSocket
  request. It's compared with a constant-time check and repeated failures
  from the same IP are rate-limited.
- **Transport:** plain HTTP/WS by default, since the tool assumes a trusted
  LAN. If you need this reachable beyond your LAN, put your own
  TLS-terminating reverse proxy in front and set `WRANGLR_SECURE=true` — don't
  expose the daemon directly to the public internet.
- **Scope:** anyone who obtains the token and can reach the daemon's port can
  read and write to any terminal pane the daemon controls, and can approve or
  reject any pending tool call. Treat the token like an SSH key to your
  machine.

## Reporting a vulnerability

Please report security issues privately by opening a
[GitHub security advisory](../../security/advisories/new) on this repository
rather than a public issue, so a fix can go out before details are public.
