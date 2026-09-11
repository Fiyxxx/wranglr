# Security

## Threat model

Wranglr is a single-user tool. Reachability is provided by Tailscale by
default: the daemon binds to loopback, and Tailscale Serve terminates TLS and
proxies your tailnet's HTTPS traffic to it. Tailscale's own ACLs restrict who
can reach the daemon to devices on your tailnet. `WRANGLR_SKIP_TAILSCALE=true`
switches to a plain local-network mode instead (no Tailscale, no relay,
same-Wi-Fi only, plain http by default) — see the README for the trade-offs.

- **Auth:** a single 256-bit token, generated on first run and persisted at
  `~/.config/wranglr/token` (mode 0600), gates every HTTP and WebSocket
  request. It's compared with a constant-time check and repeated failures
  from the same IP are rate-limited.
- **Transport:** HTTPS/WSS via Tailscale Serve by default. In
  `WRANGLR_SKIP_TAILSCALE=true` mode it's plain HTTP/WS unless you put your
  own TLS-terminating reverse proxy in front and set `WRANGLR_SECURE=true` —
  don't expose the daemon directly to the public internet either way.
- **Scope:** anyone who obtains the token and can reach the daemon (any device
  on your tailnet, or on your LAN in skip mode) can read and write to any
  terminal pane the daemon controls, and can approve or reject any pending
  tool call. Treat the token like an SSH key to your machine.

## Reporting a vulnerability

Please report security issues privately by opening a
[GitHub security advisory](../../security/advisories/new) on this repository
rather than a public issue, so a fix can go out before details are public.
