# Wranglr PWA + Approval Wiring — Design

**Status:** Approved. Companion to `SPEC.md` (§7.6) and the daemon plan (`docs/superpowers/plans/2026-08-24-wranglr-daemon.md`), which is already merged to `main`.

## Scope

This design covers what SPEC.md §7.6 deferred and what the daemon's final review flagged as a documented v1 scope cut:

1. Wiring the daemon's `approval_request` / `approval_response` flow end-to-end (previously: `hook_event` published, but `PreToolUse` never actually blocked on a decision).
2. The actual Claude Code hook script + `.claude/settings.json` wiring so a `PreToolUse` hook call really blocks on the daemon's decision.
3. The PWA itself: pairing, dashboard, worktree detail, approvals, push notifications.

## Decisions (locked, in order made)

1. **Approval wiring is in-scope now**, not deferred further — the PWA is not useful without a working approve/deny loop.
2. **Deny-on-timeout.** If no phone response arrives, the tool call is denied (fails closed, not open).
3. **Timeout: 120 seconds.**
4. **Build the real hook script + settings.json wiring** (not a stub) — approval must actually block Claude Code, not just publish an event nobody blocks on.
5. **Pairing UX: both** manual entry (hostname/port/token typed in) and QR scan (daemon prints a QR to its terminal; phone camera scans it).
6. **PWA dev workflow: real daemon only.** No mock daemon/fixture server — develop and test against a locally running `wranglr-daemon` process, same as the daemon's own live-testing approach.
7. **Reconnect/offline UX: small persistent indicator** (a badge showing connected/connecting/disconnected), not a full-screen blocking state.
8. **State management: plain React Context + `useReducer`.** No external state library — the message set is small and fully typed already via `@wranglr/protocol`.
9. **Navigation: real Next.js App Router routes** (`/pair`, `/pair/scan`, `/dashboard`, `/worktree/[id]`), not a single-page tab switcher.

## Corrections made while writing the implementation plan

- **Hook contract**, confirmed against current Claude Code docs (not guessed — see rationale in `SPEC.md`'s Herdr correction precedent, same discipline applied here): a `PreToolUse` hook script controls the outcome via stdout JSON `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"|"deny","permissionDecisionReason":"..."}}`, exit 0. Exit code `2` hard-blocks regardless of JSON. `"ask"` escalates to Claude Code's own permission UI, not back to us — the daemon must never emit `"ask"`; it resolves to `allow`/`deny` itself before responding. The hook's own `timeout` field in `.claude/settings.json` defaults to 600s and **exceeding it defaults to ALLOW** — since our own budget is 120s, the hook's configured timeout is set to 130s so Claude Code's fallback never fires before ours does.
- **Protocol types already defined** in `packages/protocol/src/index.ts` use `ApprovalResponseSchema.decision: "approve" | "reject"` (not `allow`/`deny` — that pairing was my shorthand in the brainstorm, the real enum is `approve`/`reject`). The plan uses the real enum throughout.
- **`ApprovalRequestSchema` requires a `risk: "low"|"medium"|"high"` field**, not previously accounted for in the brainstorm. Resolved with a simple static per-tool table (`daemon/src/approvals/risk.ts`): `Bash`/`Write`/`MultiEdit`/`NotebookEdit` → `high`; `Edit` → `medium`; `Read`/`Glob`/`Grep`/`WebFetch`/`WebSearch` → `low`; anything else → `medium`. This is a display hint for the phone UI only — it does not affect the allow/ask policy decision, which stays governed by `policy-engine.ts`.
- **No push-subscription registration endpoint existed.** `PushManager.addSubscription()` was defined but never called from anywhere. Added a token-authed `POST /push-subscribe` route on the existing WS server's HTTP handler (same port, same token check as the WebSocket upgrade — no new port), plus a `GET /vapid-public-key` route so the PWA can fetch the public key it needs to create a browser `PushSubscription`.
- **Serwist is dropped.** Its own docs state the standard `withSerwistInit` setup targets webpack/Turbopack server mode and explicitly does not document `output: 'export'` static-export compatibility. This app has no meaningful offline mode anyway (it is useless without a live connection to the daemon) — the only real PWA requirements are installability (manifest) and a service worker capable of handling `push` events. Both are trivial to hand-roll as a static `public/sw.js` with no build-time precache injection, avoiding an unsupported dependency path entirely.
- **Testing approach for the PWA:** pure logic (WS client, reducer, pairing storage/parsing, risk display, push-payload helpers) gets full TDD unit tests via `bun:test`. React components get smoke-level render tests via `@testing-library/react` + `happy-dom` (registered through a `bunfig.toml` preload, per Bun's documented DOM-testing setup). Camera-based QR scanning and actual browser push-permission grants are not automatable — those tasks specify manual verification steps instead, consistent with how the daemon plan handled the two live-only Herdr bugs.

## Architecture

```
┌─────────────┐  hook POST /hook   ┌────────────┐  approval_request (WS)   ┌─────────┐
│ Claude Code │ ──────────────────>│   Daemon   │ ────────────────────────>│  PWA    │
│ hook script │  (stdin = payload)  │            │<──────────────────────── │ (phone) │
│             │<── hookSpecificOutput JSON ─────│  (Promise blocks on     │         │
└─────────────┘   exit 0            │  registry until approve/           └─────────┘
                                     │  reject or 120s timeout)
                                     └────────────┘
```

- New `daemon/src/approvals/approval-registry.ts`: `Map<id, {resolve, timer}>`, `request(id, timeoutMs): Promise<"approve"|"reject">`, `respond(id, decision): boolean`.
- `daemon/src/hooks/hook-server.ts`: `PreToolUse` handling becomes `async`, returns the real `hookSpecificOutput` JSON instead of a bare `"ok"`.
- `daemon/src/index.ts`: policy `"ask"` branch publishes `approval_request` (with computed `risk`), awaits the registry, translates `"approve"`→`allow`/`"reject"`→`deny`. `onClientMessage` gains an `approval_response` case calling `registry.respond`.
- `daemon/src/ws-server.ts`: gains `POST /push-subscribe` and `GET /vapid-public-key` HTTP routes alongside the existing WS upgrade handler.
- `daemon/scripts/hook.sh`: pipes Claude Code's hook stdin JSON straight to `POST http://127.0.0.1:$WRANGLR_HOOK_PORT/hook` and echoes the response verbatim to stdout, exit 0.
- Root `.claude/settings.json`: wires `PreToolUse`/`PostToolUse` to `daemon/scripts/hook.sh`, `timeout: 130` on `PreToolUse`. This dogfoods Wranglr on its own repo, same as the daemon's live-testing approach.
- New `pwa/` Next.js App Router package (`output: 'export'`), plain CSS, Context+useReducer state, native `WebSocket`, hand-rolled `public/sw.js` + `public/manifest.json`.

## Open items intentionally left out of this plan (unchanged v1 scope cuts)

- `dependency-check.ts` / `test-runner.ts` verification modules remain unwired into the hook flow (pre-existing, deliberate cut from the daemon plan, not revisited here).
- No pairing crypto beyond the existing shared token — QR just encodes `{hostname, port, token}` as JSON, it is not a new auth mechanism.
- No multi-user / multi-phone-with-different-permissions model — any paired phone can approve/reject anything, matching the daemon's existing single-shared-token trust model.
