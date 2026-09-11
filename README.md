# Wranglr

Wranglr puts your real Herdr terminal in a desktop- and phone-friendly PWA. A
small Bun daemon mirrors ANSI pane output, forwards raw keyboard input to the
same pane, observes session state, and carries approvals to any device on your
local network — no VPN or extra app required.

> **Project status:** early alpha. Wranglr is a single-user personal tool, not a
> hardened remote-access product. The session, approval, prompt, pairing, and
> push-notification paths are implemented. See [SPEC.md](./SPEC.md) for the full
> design and roadmap.

## What it does

- Renders the available Herdr pane scrollback with ANSI colors and formatting.
- Sends normal typing, control keys, escape, tab, arrows, and enter directly to the selected pane.
- Switches between active Herdr/Claude Code sessions without hiding their output.
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
│ • ANSI terminal      │   Local Wi-Fi  │ • Herdr socket adapter     │
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
bound to `127.0.0.1`, while the authenticated WebSocket listener binds to all
interfaces (`0.0.0.0`) so any device on the same local network can reach it.
There's no NAT traversal or public relay — your phone must be on the same
Wi-Fi as the development machine. See [SECURITY.md](./SECURITY.md) for the
full trust model.

## Prerequisites

- [Bun](https://bun.sh/) 1.x
- Herdr running with its socket API available
- Claude Code for hook integration
- A phone and development machine on the same local network
- A modern browser with service worker support

## Quick start

```bash
git clone https://github.com/Fiyxxx/wranglr.git
cd wranglr
bun run start
```

That one command installs dependencies, builds the production PWA, creates a
persistent pairing token and safe default policy, auto-detects this machine's
LAN IP address, and starts the PWA and daemon. It prints the phone URL, a QR
code, and the same pairing details as plain text. Press `Ctrl+C` to stop both
local processes.

Start Herdr on the development machine before running the command. On the
phone, join the same Wi-Fi network and open the printed URL directly, or open
the PWA and pair it:

- **Manual entry** (works everywhere, including plain http): go to `/pair`,
  and enter the hostname, port, and token printed in the terminal.
- **QR scan**: go to `/pair/scan`. This needs a secure context (HTTPS), which
  local Wi-Fi mode doesn't provide by default — see
  [SECURITY.md](./SECURITY.md) if you want to put a TLS reverse proxy in
  front and enable it.

The dashboard should show **Connected** and list active Herdr agents; opening
a worktree lets you send coding prompts. Install the PWA to the phone's home
screen before enabling push notifications (push also needs a secure context —
see SECURITY.md).

Wranglr stores its generated token and policy in `~/.config/wranglr/`, so the
same phone pairing continues to work on later runs.

### Approval policy

The first run creates `~/.config/wranglr/policy.json` with an empty object. This
is safe by default: every unlisted worktree is `guarded` and every tool call
requires phone approval. Add absolute worktree paths if you want a different
tier:

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

### Claude Code hooks

The launcher handles Wranglr itself, but it does not modify your repositories.
Add these hooks once to `.claude/settings.json` in each repository where you
want phone approval of Claude Code tool calls. Replace the command with the
absolute path to this checkout's hook script.

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

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `WRANGLR_TOKEN` | No | Generated and persisted | Override the shared pairing token |
| `WRANGLR_BIND_HOST` | No | `WRANGLR_HOSTNAME` or `0.0.0.0` | Local daemon bind address |
| `WRANGLR_PUBLIC_HOST` | No | Auto-detected LAN IPv4 | Override the hostname placed in the pairing payload |
| `WRANGLR_PUBLIC_PORT` | No | Same as `WRANGLR_WS_PORT` | Public daemon port placed in the pairing payload |
| `WRANGLR_SECURE` | No | `false` | Set `true` only if you've put a TLS proxy in front |
| `WRANGLR_HOSTNAME` | No | `127.0.0.1` | Backward-compatible combined bind/public hostname |
| `WRANGLR_WS_PORT` | No | `7420` | WebSocket and push HTTP port |
| `WRANGLR_HOOK_PORT` | No | `7421` | Loopback Claude Code hook port |
| `WRANGLR_POLICY_PATH` | No | `~/.config/wranglr/policy.json` | Worktree policy JSON path |
| `WRANGLR_HERDR_SOCKET_PATH` | No | `~/.config/herdr/herdr.sock` | Herdr socket path |
| `WRANGLR_VAPID_SUBJECT` | No | `mailto:wranglr@example.com` | Web Push VAPID contact URI |
| `WRANGLR_PWA_HOST` | No | `0.0.0.0` | Static PWA server bind address |
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

1. Start Herdr, then run `bun run start` from the Wranglr checkout.
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

See [SECURITY.md](./SECURITY.md) for the full threat model. In short: keep the
daemon on a trusted local network, don't expose its port directly to the
public internet, and treat the pairing token like an SSH key.

## Scope

Wranglr is a single-user remote view of existing Herdr panes. Herdr remains the
PTY and scrollback source of truth; Wranglr does not create a parallel SSH shell.
Multi-user collaboration, cloud relays, and custom NAT traversal are outside the
current scope.
