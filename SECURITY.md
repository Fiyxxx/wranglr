# Security

## Threat model

Wranglr is a single-user tool with three interchangeable networking modes
(`WRANGLR_TUNNEL`: `tailscale`, `cloudflare`, `none`). All three share the same
auth and approval logic; only reachability and who sits in the traffic path
differ.

- **`tailscale` (default):** the daemon binds to loopback; Tailscale Serve
  terminates TLS and proxies your tailnet's HTTPS traffic to it. Tailscale's
  own ACLs restrict who can reach the daemon to devices on your tailnet.
  Traffic between your devices travels over WireGuard — Tailscale the company
  is a coordination/relay-of-last-resort service, not a party that sees your
  terminal session content in the common case.
- **`cloudflare`:** the daemon binds to loopback; two Cloudflare Quick Tunnels
  (`cloudflared`) proxy the PWA and the daemon to random `*.trycloudflare.com`
  HTTPS hostnames, reachable from any network. Unlike Tailscale, **Cloudflare's
  edge terminates TLS to route your traffic** — it can see your terminal
  session content in transit, even though it's encrypted against everyone
  else. This is a real trust trade-off for not installing anything on your
  phone. The tunnel hostnames are random and rotate every restart, but they
  are public URLs — anyone who guesses or observes one still needs the token
  to do anything through it.
- **`none`:** the daemon binds to all interfaces directly, reachable only on
  your local Wi-Fi. No third party is in the path at all, but transport is
  plain HTTP/WS by default (no TLS) unless you supply your own reverse proxy.

- **Auth (all modes):** a single 256-bit token, generated on first run and
  persisted at `~/.config/wranglr/token` (mode 0600), gates every HTTP and
  WebSocket request. It's compared with a constant-time check and repeated
  failures from the same IP are rate-limited.
- **Don't expose the daemon's port directly to the public internet** via your
  own port-forwarding in any mode — use one of the three built-in modes
  instead, or your own TLS-terminating reverse proxy if you go fully custom.
- **Scope:** anyone who obtains the token and can reach the daemon (via your
  tailnet, the Cloudflare tunnel URL, or your LAN) can read and write to any
  terminal pane the daemon controls, and can approve or reject any pending
  tool call. Treat the token like an SSH key to your machine.

## Reporting a vulnerability

Please report security issues privately by opening a
[GitHub security advisory](../../security/advisories/new) on this repository
rather than a public issue, so a fix can go out before details are public.
