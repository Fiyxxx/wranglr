# Wranglr — Technical Specification

## 1. What this is

Wranglr is a remote Herdr terminal for a development workflow centered on Herdr and git worktrees. It is a PWA (not a native app) that connects to a daemon running on the developer's own machine over Tailscale (or, optionally, the plain local network — see Section 4). The terminal is the product: Wranglr mirrors each pane's ANSI output and sends keyboard input back to that exact pane. Session status, approvals, and notifications are supporting controls layered around it.

This is a single-user personal tool. It is not being built to compete with Moshi, Paseo, Cosyra, or any other product in this space — those were evaluated during design and are referenced in Section 8 (Rejected Approaches) purely so this spec doesn't silently reintroduce ideas that were already considered and set aside.

## 2. Goals

- Read the complete available ANSI scrollback for every active Herdr pane, not a summary of agent activity.
- Type into a Herdr pane from desktop or mobile, including control, escape, navigation, and tab keys.
- Switch between every active Herdr session / git worktree without leaving the terminal workspace.
- Approve or reject risky agent actions (tool calls, diffs) from a phone.
- Get a push notification when an agent needs input or finishes a task, without keeping the app open.
- Independently verify agent claims (tests actually pass, dependencies actually exist) before showing "safe to approve."
- Zero ongoing cost, zero third-party infrastructure to maintain beyond Tailscale (free tier).
- Installable on a phone home screen with no App Store dependency.

## 3. Non-goals (for now)

- Not a replacement for Herdr: Wranglr remotely presents and controls Herdr's existing panes; it does not host its own shells or PTYs.
- Not multi-user, not a team tool, no shared/collaborative sessions.
- Not trying to support harnesses other than Claude Code at this stage.
- Not trying to solve NAT traversal ourselves — Tailscale already does this.

## 4. Architecture overview

```
Phone (PWA, Next.js)              Dev machine (daemon, Bun/TypeScript)
┌────────────────────┐            ┌──────────────────────────┐
│ ANSI terminal UI    │            │ WebSocket server          │
│ Session + approvals │◄──wss──────►│ (bound to Tailscale IP)  │
│ Push registration   │  over      │                           │
└────────────────────┘  Tailscale │ Herdr/tmux adapter         │
                                    │ Claude Code hook receiver │
                                    │ Verification module       │
                                    │ Worktree policy engine    │
                                    │ Web Push sender           │
                                    └──────────────────────────┘
```

Reachability is handled entirely by Tailscale (installed as a normal app on both the phone and the dev machine). The daemon binds to loopback; Tailscale Serve terminates TLS and proxies the tailnet-facing HTTPS port to it. The PWA connects to `wss://<machine>.<tailnet>.ts.net:<port>`. No relay server, no signaling server, no WebRTC, no embedded VPN library. This was a deliberate simplification — see Section 8.

**Alternatives via `WRANGLR_TUNNEL`:** for anyone who'd rather not install Tailscale, two other modes are supported (see Section 8 for why each rejected/accepted option landed where it did):
- `cloudflare` — the daemon still binds to loopback, but two Cloudflare Quick Tunnels (`cloudflared tunnel --url`) proxy the daemon and PWA to public `*.trycloudflare.com` HTTPS hostnames instead of Tailscale Serve. Reachable from any network, no app to install on the phone, `cloudflared` needed on the dev machine only. Trade-off: Cloudflare's edge terminates TLS to route the traffic, so it's not end-to-end between your own devices the way Tailscale is (see SECURITY.md).
- `none` — the daemon instead binds to all interfaces (`0.0.0.0`) and the launcher auto-detects the machine's LAN IPv4 address for the pairing payload. Same Wi-Fi network only, no NAT traversal, plain http unless you supply your own TLS proxy. Trades all cross-network reachability for zero extra app or third party involved at all.

## 5. Herdr and Claude Code are two separate integration concerns

This distinction matters and should not be collapsed into one adapter:

**Claude Code integration** — well-documented, stable public API. The daemon runs an HTTP listener that `.claude/settings.json` hooks POST to:
- `PreToolUse` — fires before a tool call executes. Used to intercept and route through the worktree policy engine (Section 7.4) before deciding allow/ask/block.
- `PostToolUse` — fires after a tool call completes. Used to trigger verification (Section 7.3) and to push diff/status events to connected phones.

This does not require reverse-engineering anything. Anthropic's hook system is the sanctioned extension point, documented at `.claude/settings.json` with `PreToolUse`/`PostToolUse` event types.

**Herdr integration** — **RESOLVED by spike (2026-08-24):** Herdr exposes session/pane state via its own Unix domain socket API at `~/.config/herdr/herdr.sock` (path follows `HERDR_CONFIG_PATH` if set) — option (b), not tmux control mode. The `herdr` CLI is documented as a thin wrapper over this same socket ("Workspace helpers over the socket API", etc. — see `herdr --help`), so the daemon should talk to the socket directly rather than shelling out to the CLI per call.

Protocol: JSON request/response over the socket, `protocol: 20` / `schema_version: 1` as of this spike. Full schema is self-describing via `herdr api schema --json` (JSON Schema, `$defs` under `request`, `event`, `subscription_event`, `success_response`, `error_response`). A one-shot full-state snapshot is available via `herdr api snapshot` (also callable directly over the socket) — returns workspaces, tabs, panes, layouts, and the live `agents` list (each with `agent_status`: idle/working/blocked/done/unknown, `cwd`, `pane_id`, `workspace_id`, `agent_session`).

Live change notification is a subscription over the same socket — `subscription_event` wraps 26 typed events, most relevant: `pane_created`, `pane_closed`, `pane_updated`, `pane_agent_detected`, `pane_agent_status_changed`, `pane_output_changed`, plus `workspace_*`/`tab_*`/`layout_updated`/`worktree_*` variants. This maps directly onto the adapter interface:

- `listSessions()` → one `api snapshot` call (or `workspace list` + `pane list`), filtered to panes with an `agent` present.
- `getPaneContent(id)` → `pane read <id>` / `agent read <target>` (source: `recent-unwrapped` for logs, `detection` for the plain-text snapshot Herdr itself uses for agent-state detection).
- `sendKeys(id, input)` → `pane send-keys` / `pane send-text`, or `agent prompt` when targeting a recognized agent (handles bracketed paste + blocked-state rejection for free).
- `onSessionChange(callback)` → subscribe on the socket, dispatch on `pane_agent_status_changed` / `pane_output_changed` / `pane_created` / `pane_closed`.

Build the adapter as an isolated module against this socket protocol (raw socket client, not CLI subprocess spawning) so it stays swappable if the protocol version changes — schema is versioned (`protocol`/`schema_version` fields), so pin and check on connect.

**Correction (found during daemon integration testing, 2026-08-24):** each connection is one-shot — Herdr closes it right after the first response, unless that first request was `events.subscribe`, in which case it stays open to stream events. A plain query (snapshot, pane read, send-keys, …) needs its own fresh connection per call; only the subscription needs a long-lived one. Do not reuse a connection across multiple plain requests.

The daemon correlates the two: a Claude Code hook event carries a working directory; the Herdr adapter maps working directories to active panes/worktrees; the event bus joins them so the phone sees "this diff belongs to the `feature-x` worktree, currently active in Herdr pane 3."

## 6. Technology choices

**Daemon: Bun + TypeScript.**
Rationale: the daemon's workload is I/O-bound (WebSocket messages, subprocess control of tmux/Herdr, HTTP hook receipts), not CPU-bound, so a compiled language's raw throughput advantage doesn't materially matter here. Bun gives native TypeScript execution with no build step, a fast built-in WebSocket server (`Bun.serve` with `websocket`), full npm ecosystem access, and can compile to a single standalone executable (`bun build --compile`) for easy startup/deployment — closer to Go's "just run the binary" experience without leaving the TypeScript ecosystem. If any native module needed for the Herdr/tmux adapter turns out to be Node-only and incompatible with Bun, fall back to Node.js — the rest of the code should be portable since it avoids Bun-specific APIs outside the server entrypoint.

**PWA: Next.js, App Router, static export.**
Yes, Next.js works for this. Since there's no need for server-side rendering, API routes, or a backend here (the daemon is the backend, reached directly over WebSocket), configure `output: 'export'` in `next.config` so the build produces a static site — this is what actually gets deployed/opened as the PWA, no Node server required at runtime on the phone side. For the service worker and manifest, use **Serwist** (the actively maintained successor to next-pwa — the original `next-pwa` package is archived; a maintained fork exists at `@ducanh2912/next-pwa` as an alternative if Serwist's App Router support has gaps). Add `manifest.json`, icons, and `theme-color` for home-screen install.

**Auth for the WebSocket handshake:** a single shared token generated on first daemon start, entered into the PWA once during setup (paste or QR code containing the token + Tailscale hostname). This is intentionally simple — see Section 8 for why the fuller pairing/crypto ceremony is deferred. The token check is constant-time and failed attempts are rate-limited per IP.

## 7. What to implement now

### 7.1 Daemon: WebSocket server + event bus
- Bun WebSocket server bound to loopback by default, reached via Tailscale Serve's or Cloudflare Tunnel's TLS-terminating proxy (or bound to all interfaces directly in `WRANGLR_TUNNEL=none` mode), token-authenticated on connect.
- Internal event bus (simple pub/sub) — every other module publishes events here; the WebSocket handler subscribes and serializes to connected clients, and relays client messages (approve/reject, prompt text) back into the bus.
- Message protocol: JSON messages with a `type` field. Minimum set for v1:
  - `worktree_status` (daemon → phone): active worktrees, which Herdr pane each is in, idle/running state.
  - `hook_event` (daemon → phone): raw PreToolUse/PostToolUse event, worktree-tagged.
  - `approval_request` (daemon → phone): a tool call awaiting a decision, with risk info attached.
  - `approval_response` (phone → daemon): approve/reject for a given request id.
  - `verification_result` (daemon → phone): pass/fail from the verification module, attached to a diff.
  - `prompt` (phone → daemon): free text to send into a specific Claude Code session.

### 7.2 Herdr/tmux adapter
Per Section 5: spike first, then implement `listSessions()`, `getPaneContent()`, `sendKeys()`, `onSessionChange()` behind a stable interface.

### 7.3 Verification module
Triggered on `PostToolUse` for commits/test runs:
- Independently re-run the test suite in an isolated shell rather than trusting Claude's own "tests pass" report.
- Diff any new `import`/`require`/`package.json` entries against the real package registry (npm/PyPI/crates as relevant) and flag anything that doesn't resolve or is suspiciously new/low-download — this catches fabricated ("hallucinated") dependencies before they're trusted.
- Publish a `verification_result` event either way; don't block on it by default, surface it alongside the diff.

### 7.4 Worktree policy engine (static tiers, not adaptive yet)
Per-worktree autonomy level, configured by the user, checked on `PreToolUse`:
- e.g. an experimental worktree = auto-approve non-destructive edits (Edit/Read), still ask for Bash/Write.
- a worktree touching production-adjacent code (Ecovolt, Beacon main) = always ask.
This is intentionally simple static config (a JSON file mapping worktree path → tier), not the adaptive fatigue-aware model from Section 9 — that requires real usage data this project doesn't have yet.

### 7.5 Web Push
- VAPID key pair generated once, stored by the daemon.
- PWA registers a push subscription on first load (after the user grants permission), sends it to the daemon over the authenticated WebSocket.
- Daemon sends a push notification (via `web-push` npm package or Bun-compatible equivalent) when an `approval_request` or a task-complete event fires while no phone is actively connected.

### 7.6 PWA: core screens
- Pairing/setup screen (enter token + Tailscale hostname, or scan QR).
- Terminal workspace — real ANSI pane output with retained scrollback, session rail, and direct keyboard input.
- Mobile terminal toolbar — control-C, escape, tab, arrows, enter, and software-keyboard focus.
- Inline approvals — pending tool input and approve/reject actions stay visible without replacing the terminal.
- Push permission prompt, shown after first successful connection (not on cold load).

### 7.7 Reconnection
- Heartbeat ping every few seconds over the WebSocket to detect a dead connection quickly rather than waiting on TCP's default timeout.
- On reconnect, daemon sends a full current-state snapshot rather than replaying a backlog — instant catch-up, no queue to chew through.

## 8. Explicitly rejected approaches (do not reintroduce without a real, validated reason)

- **Always-on cloud container (Cosyra-style)** — rejected: recurring cost, doesn't fit "use my own subscription" requirement, doesn't add anything the daemon-on-own-machine model doesn't already give.
- **Native app with Mosh/SSH** — rejected in favor of a PWA speaking directly to the local daemon over the tailnet. Raw terminal interaction is required, but Herdr already owns the PTY and scrollback, so a second SSH session would be the wrong source of truth.
- **Self-hosted outbound-relay pattern (Paseo/Happy style, running your own relay)** — rejected: would mean running and patching a public relay server yourself, real ongoing infra for a single-user tool. **Cloudflare Tunnel is the same shape of pattern but adopted anyway** (`WRANGLR_TUNNEL=cloudflare`) because it's a free, third-party-operated relay with zero maintenance on our side — the trade-off is Cloudflare's edge seeing traffic in transit (documented in SECURITY.md), not the maintenance burden that got the self-hosted version rejected.
- **Embedded Tailscale (`tsnet` compiled into the app)** — rejected: real native-module integration cost for no benefit over just installing the Tailscale app normally on both devices.
- **WebRTC DataChannels + predictive echo** — rejected for now. WebSocket input over a private tailnet is the baseline; revisit only if measured typing latency proves it necessary.
- **Full public-key pairing/handshake ceremony on top of Tailscale** — deferred, not rejected outright: real defense-in-depth, but for a single-user tool where Tailscale ACLs already restrict reachability to owned devices, a shared token with constant-time comparison and rate limiting is proportionate for now.
- **Adaptive, fatigue-calibrated approval escalation** — deferred: the underlying idea (don't flatly ask every time; model approval-capacity and escalate only when it matters) is good but needs real usage history to calibrate against, which doesn't exist before the static-tier version (7.4) has been used for a while.

## 9. Future considerations, and when to revisit them

- **WebRTC unreliable DataChannel + predictive echo**: revisit only if typing in the shipped terminal view genuinely feels laggy on real networks in daily use.
- **WebTransport** as a cleaner alternative to WebRTC for the above: revisit once it's had more time to mature on iOS Safari (it only shipped there recently); treat any adoption as additive behind the same message-layer abstraction, not a rewrite.
- **Adaptive/fatigue-aware approval escalation**: once the static per-worktree tiers (7.4) have real usage history, consider modeling approval frequency/recency to dynamically suppress low-value notifications rather than escalating everything that clears the static tier.
- **Full pairing handshake (public-key, not shared token)**: worth adding once/if this is ever used from more than one phone, or if the threat model expands beyond "just me."
- **Multi-harness support (Codex, etc.)**: the hook receiver (7.1/7.3) is Claude-Code-specific by design right now; if a second harness is added later, check whether it has an equivalent hook system before assuming the same adapter shape works.
- **Consensus-based hallucination detection** (multiple-sample agreement checking, beyond the deterministic re-run in 7.3): a heavier verification technique worth considering only if the simple re-run/dependency-check approach in 7.3 turns out to miss real issues in practice.

## 10. Open questions to resolve during implementation

1. ~~How does Herdr actually expose session/pane state~~ — **RESOLVED**: Unix socket at `~/.config/herdr/herdr.sock`, JSON protocol, see Section 5.
2. Exact shape of the worktree → policy-tier config file (7.4) — simple JSON is assumed; confirm this covers real usage before adding anything fancier.
3. Where the verification module's isolated test re-run should run relative to the repo's existing test tooling — needs to be repo-agnostic enough to work across Beacon, Ecovolt, and Assessmate's different stacks.
