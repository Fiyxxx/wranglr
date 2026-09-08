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
- Tailscale on the development machine and phone, with its CLI available for
  Tailscale Serve
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

### 3. Build and serve the PWA

Build the static app and serve it locally:

```bash
bun run --cwd pwa build
bun run --cwd pwa serve
```

The local PWA server listens on `127.0.0.1:3000` by default.

### 4. Expose both local services with Tailscale Serve

Wranglr uses two private HTTPS endpoints: port `443` for the PWA and port `8443`
for the daemon. [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve)
terminates TLS and keeps both endpoints inside your tailnet.

```bash
tailscale serve --bg --https=443 http://127.0.0.1:3000
tailscale serve --bg --https=8443 http://127.0.0.1:7420
```

The command output includes your machine's `*.ts.net` hostname. Keep it for the
next step.

### 5. Start the daemon

Choose a long random shared token. Bind the daemon locally, but put the secure
Tailscale hostname and public port in its QR payload:

```bash
export WRANGLR_TOKEN="replace-with-a-long-random-value"
export WRANGLR_BIND_HOST="127.0.0.1"
export WRANGLR_PUBLIC_HOST="your-machine.tailnet-name.ts.net"
export WRANGLR_PUBLIC_PORT="8443"
export WRANGLR_SECURE="true"
bun run --cwd daemon start
```

The daemon listens locally on port `7420`, starts its loopback-only hook server
on port `7421`, creates its push state under `~/.config/wranglr/`, and prints a
secure QR pairing payload in the terminal.

### 6. Add Claude Code hooks

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

### 7. Pair the phone

With Tailscale connected on the phone, open:

```text
https://your-machine.tailnet-name.ts.net
```

Scan the QR shown by the daemon. For manual pairing, enter the `*.ts.net`
hostname, port `8443`, the shared token, and enable **Use HTTPS/WSS**.

After pairing, the dashboard should show **Connected** and list every active
Herdr agent. Install the site to the phone's home screen before enabling Web Push.

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `WRANGLR_TOKEN` | Yes | — | Shared token for WebSocket and push endpoints |
| `WRANGLR_BIND_HOST` | No | `WRANGLR_HOSTNAME` or `127.0.0.1` | Local daemon bind address |
| `WRANGLR_PUBLIC_HOST` | No | Bind address | Hostname placed in the pairing payload |
| `WRANGLR_PUBLIC_PORT` | No | `WRANGLR_WS_PORT` | Public daemon port placed in the pairing payload |
| `WRANGLR_SECURE` | No | `false` | Use HTTPS/WSS in the pairing payload |
| `WRANGLR_HOSTNAME` | No | `127.0.0.1` | Backward-compatible combined bind/public hostname |
| `WRANGLR_WS_PORT` | No | `7420` | WebSocket and push HTTP port |
| `WRANGLR_HOOK_PORT` | No | `7421` | Loopback Claude Code hook port |
| `WRANGLR_POLICY_PATH` | No | `~/.config/wranglr/policy.json` | Worktree policy JSON path |
| `WRANGLR_HERDR_SOCKET_PATH` | No | `~/.config/herdr/herdr.sock` | Herdr socket path |
| `WRANGLR_VAPID_SUBJECT` | No | `mailto:wranglr@example.com` | Web Push VAPID contact URI |
| `WRANGLR_PWA_HOST` | No | `127.0.0.1` | Static PWA server bind address |
| `WRANGLR_PWA_PORT` | No | `3000` | Static PWA server port |

## Development

```bash
# Run every package's tests
bun run test

# Run one package
bun run --cwd daemon test
bun run --cwd pwa test

# Start the PWA development server
bun run --cwd pwa dev

# Build and serve the production PWA
bun run --cwd pwa build
bun run --cwd pwa serve
```

### Phone acceptance test

1. Start Herdr, the Wranglr daemon, the PWA server, and both Tailscale Serve
   endpoints.
2. Open the PWA on the phone, pair it, and confirm the badge says **Connected**.
3. Open a listed worktree, submit a harmless prompt, and confirm **Prompt
   delivered to Herdr** appears and the agent begins the requested turn.
4. Put that worktree in the `guarded` policy tier and ask the agent to use a
   tool. Confirm the tool input appears on the phone before approving it.
5. Reload the PWA while an approval is pending. The approval should still be
   present; approve or reject it and confirm the Claude Code tool resumes with
   the same decision.
6. Install the PWA to the home screen, select **Enable notifications**, then
   trigger another guarded tool call to check push delivery.

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
- Use the HTTPS/WSS pairing mode through Tailscale Serve for camera access,
  installation, and Web Push. Plain HTTP mode is intended only for localhost
  development.
- The Claude Code hook listener binds only to loopback and is not exposed to the
  tailnet.

## Scope

Wranglr is deliberately focused on structured agent events rather than raw
terminal streaming. It is single-user, Claude-Code-specific, and relies on
Tailscale for reachability. Multi-user collaboration, a general remote terminal,
cloud relays, and custom NAT traversal are outside the current scope.
