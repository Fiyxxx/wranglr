# Wranglr

Wranglr is a mobile control surface for a development workflow built around
Herdr, Claude Code, and git worktrees. A small Bun daemon runs on your
development machine, observes active Herdr sessions, receives Claude Code hook
events, and exposes them to a phone-friendly Next.js app over your tailnet.

> **Project status:** early alpha. Wranglr is a single-user personal tool, not a
> hardened remote-access product. The core session, approval, prompt, pairing,
> and push-notification paths are implemented; diff presentation and runtime
> verification wiring are still in progress. See [SPEC.md](./SPEC.md) for the
> full design and roadmap.

## What it does

- Shows active Herdr/Claude Code sessions and their current status.
- Streams `PreToolUse` and `PostToolUse` events to the web app.
- Applies a per-worktree approval policy before Claude Code tool calls run.
- Lets you approve, reject, or send a prompt from another device.
- Sends Web Push notifications when an approval is waiting.
- Re-sends the current session snapshot whenever a client connects.
- Shares a Zod-validated message protocol between the daemon and PWA.

## Architecture

```text
Phone or browser                         Development machine
┌──────────────────────┐                 ┌────────────────────────────┐
│ Next.js static PWA   │   WebSocket    │ Bun daemon                 │
│                      │◄───────────────►│                            │
│ • session status     │   Tailscale    │ • Herdr socket adapter     │
│ • approvals          │                 │ • Claude Code hook server  │
│ • prompts            │                 │ • worktree policy engine   │
│ • notifications      │                 │ • Web Push sender          │
└──────────────────────┘                 └─────────────┬──────────────┘
                                                     │ Unix socket
                                               ┌─────▼─────┐
                                               │   Herdr   │
                                               └───────────┘
```

The daemon talks directly to Herdr's Unix socket at
`~/.config/herdr/herdr.sock`. Claude Code hooks reach a separate HTTP listener
bound to `127.0.0.1`, while the authenticated WebSocket listener can be bound to
an address reachable through Tailscale.

## Prerequisites

- [Bun](https://bun.sh/) 1.x
- Herdr running with its socket API available
- Claude Code for hook integration
- Tailscale on the development machine and phone for remote access
- A modern browser with service worker support

## Quick start

### 1. Install dependencies

```bash
git clone https://github.com/Fiyxxx/wranglr.git
cd wranglr
bun install
```

### 2. Create a policy file

The daemon expects a JSON policy file to exist before it starts:

```bash
mkdir -p ~/.config/wranglr
cp daemon/config/policy.example.json ~/.config/wranglr/policy.json
```

Edit the copied file so its keys are absolute paths to your own worktrees:

```json
{
  "/absolute/path/to/an/experimental-worktree": "experimental",
  "/absolute/path/to/a/sensitive-worktree": "guarded"
}
```

Policy behavior is intentionally small and predictable:

| Tier | Automatically allowed | Sent for approval |
| --- | --- | --- |
| `experimental` | `Read`, `Edit` | Every other tool |
| `guarded` | Nothing | Every tool |

Unlisted worktrees default to `guarded`. An unanswered approval is denied after
120 seconds.

### 3. Start the daemon

Choose a long random shared token and bind the daemon to your machine's
Tailscale address or MagicDNS hostname:

```bash
export WRANGLR_TOKEN="replace-with-a-long-random-value"
export WRANGLR_HOSTNAME="your-machine.tailnet-name.ts.net"
bun run --cwd daemon start
```

The daemon listens on WebSocket port `7420`, starts its loopback-only hook server
on port `7421`, creates VAPID keys under `~/.config/wranglr/`, and prints a QR
pairing payload in the terminal.

### 4. Add Claude Code hooks

Add the following to `.claude/settings.json` in each repository you want Wranglr
to observe. Replace the command with the absolute path to this checkout's hook
script.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/wranglr/daemon/scripts/hook.sh",
            "timeout": 130
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/wranglr/daemon/scripts/hook.sh",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

If you change `WRANGLR_HOOK_PORT`, expose the same value to Claude Code's hook
environment.

### 5. Run and pair the web app

For development on your tailnet:

```bash
bun run --cwd pwa dev --hostname 0.0.0.0
```

Open `http://<your-tailscale-host>:3000` on the other device. Enter the daemon
hostname, port, and token manually, or use the QR scanner when the browser allows
camera access.

The PWA is configured as a static export. Once the production build path is
ready for your environment, `bun run --cwd pwa build` writes the site to
`pwa/out/`.

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `WRANGLR_TOKEN` | Yes | — | Shared token for WebSocket and push endpoints |
| `WRANGLR_HOSTNAME` | No | `127.0.0.1` | Address used by the daemon and pairing payload |
| `WRANGLR_WS_PORT` | No | `7420` | WebSocket and push HTTP port |
| `WRANGLR_HOOK_PORT` | No | `7421` | Loopback Claude Code hook port |
| `WRANGLR_POLICY_PATH` | No | `~/.config/wranglr/policy.json` | Worktree policy JSON path |

## Development

```bash
# Run every package's tests
bun run test

# Run one package
bun run --cwd daemon test
bun run --cwd pwa test

# Start the PWA development server
bun run --cwd pwa dev
```

Repository layout:

```text
daemon/             Bun daemon, integrations, policy, approvals, and push
packages/protocol/  Shared Zod schemas and TypeScript message types
pwa/                Next.js App Router client and service worker
docs/               Design notes and implementation plans
SPEC.md              Technical specification and architectural decisions
```

## Security notes

- Keep the daemon on a trusted tailnet. Do not expose port `7420` directly to the
  public internet.
- Authentication is currently a shared token carried in a query parameter and
  stored in browser local storage.
- The current client uses plain `ws://` and `http://`. TLS/WSS support is not yet
  wired, so HTTPS-hosted clients will encounter mixed-content restrictions.
- Camera access, installation, and Web Push generally require a secure browser
  context; those features may therefore be limited during the HTTP-only alpha.
- The Claude Code hook listener binds only to loopback and is not exposed to the
  tailnet.

## Scope

Wranglr is deliberately focused on structured agent events rather than raw
terminal streaming. It is single-user, Claude-Code-specific, and relies on
Tailscale for reachability. Multi-user collaboration, a general remote terminal,
cloud relays, and custom NAT traversal are outside the current scope.
