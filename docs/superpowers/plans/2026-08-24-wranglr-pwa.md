# Wranglr PWA + Approval Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the daemon's `approval_request`/`approval_response` flow end-to-end (including a real Claude Code hook script that actually blocks tool calls), then build the PWA — pairing, dashboard, worktree detail, approvals, push notifications — completing SPEC.md §7.6.

**Architecture:** Daemon-side, `PreToolUse` handling becomes async: a policy `"ask"` decision publishes an `approval_request` over the WS bus, opens a 120s-timeout promise in a new pending-approval registry, and the hook HTTP response doesn't return until that promise resolves (by phone response or timeout-deny). A new hook script pipes Claude Code's hook stdin straight to the daemon and echoes back its JSON verbatim. PWA-side: a Next.js App Router static-export app with a thin typed WebSocket client, a Context+`useReducer` store fed by `@wranglr/protocol`'s `ServerMessage` union, and a hand-rolled service worker for push (no Serwist — see spec for why).

**Tech Stack:** Bun/TypeScript (daemon additions, same conventions as the existing daemon), Next.js App Router with `output: 'export'`, native browser `WebSocket`/`PushManager`/`getUserMedia` APIs, `jsQR` (QR decode), `qrcode-terminal` (QR encode, daemon-side), `@testing-library/react` + `happy-dom` for PWA component smoke tests.

**Spec:** `docs/superpowers/specs/2026-08-24-wranglr-pwa-design.md` — read this first, it documents every correction made to the original brainstorm (protocol enum values, the `risk` field, the hook JSON contract, dropping Serwist) with rationale. Also see `SPEC.md` §7.6 and the daemon plan's Global Constraints for the Herdr/protocol ground truth this plan builds on top of.

## Global Constraints

- `ApprovalResponseSchema.decision` is `"approve" | "reject"` — never `"allow"`/`"deny"` on the wire. Only the hook's own `permissionDecision` field (a different, Claude-Code-specific vocabulary) uses `"allow"`/`"deny"`.
- `ApprovalRequestSchema.risk` is required (`"low"|"medium"|"high"`) — every `approval_request` publish must include it.
- The daemon must never emit `permissionDecision: "ask"` — it always resolves to `allow` or `deny` itself before responding to the hook.
- A `PreToolUse` hook's Claude-Code-side `timeout` (in `.claude/settings.json`) defaults to 600s and defaults to **ALLOW** if exceeded — our own approval budget is 120s, so every `PreToolUse` hook entry we write sets `"timeout": 130`.
- No Serwist. The service worker is a hand-written static file at `pwa/public/sw.js`, registered manually — see spec's "Serwist is dropped" section.
- PWA dev/testing is against a real running `wranglr-daemon` process — no mock daemon.
- State management is plain React Context + `useReducer`. No Redux/Zustand/etc.
- Navigation is real Next.js App Router routes, not client-side tab state.
- Pairing data (`hostname`, `port`, `token`) persists in `localStorage` under key `wranglr.pairing`.

---

## File Structure

```
wranglr/
├── .claude/
│   └── settings.json                       # NEW — wires this repo's own Claude Code hooks to the daemon
├── daemon/
│   ├── package.json                        # + qrcode-terminal dependency
│   ├── scripts/
│   │   └── hook.sh                         # NEW — Claude Code hook → daemon HTTP bridge
│   └── src/
│       ├── approvals/
│       │   ├── risk.ts                     # NEW
│       │   └── approval-registry.ts        # NEW
│       ├── pairing/
│       │   └── pairing-payload.ts          # NEW — builds the QR's JSON payload
│       ├── hooks/hook-server.ts            # MODIFY — async PreToolUse decision contract
│       ├── ws-server.ts                    # MODIFY — + POST /push-subscribe, GET /vapid-public-key
│       └── index.ts                        # MODIFY — wire registry, risk, QR printout, approval_response
└── pwa/
    ├── package.json                         # NEW
    ├── tsconfig.json                        # NEW
    ├── next.config.ts                       # NEW — output: 'export'
    ├── bunfig.toml                          # NEW — happy-dom preload for component tests
    ├── test-setup.ts                        # NEW
    ├── public/
    │   ├── manifest.json                    # NEW
    │   └── sw.js                            # NEW — hand-rolled push service worker
    ├── lib/
    │   ├── ws-client.ts                     # NEW
    │   ├── store.tsx                        # NEW — WranglrProvider + useWranglr
    │   ├── pairing.ts                       # NEW — localStorage save/load + payload parsing
    │   └── push.ts                          # NEW — permission + subscribe flow
    ├── components/
    │   └── ConnectionBadge.tsx              # NEW
    └── app/
        ├── layout.tsx                       # NEW
        ├── page.tsx                         # NEW — redirects to /pair or /dashboard
        ├── pair/
        │   ├── page.tsx                     # NEW — manual entry form
        │   └── scan/page.tsx                # NEW — QR camera scan
        ├── dashboard/page.tsx                # NEW
        └── worktree/[id]/page.tsx            # NEW
```

Root `package.json` gains `"pwa"` in `workspaces`.

---

## Task 1: Risk assessment helper

**Files:**
- Create: `daemon/src/approvals/risk.ts`
- Test: `daemon/test/approvals/risk.test.ts`

**Interfaces:**
- Produces: `assessRisk(tool: string): "low" | "medium" | "high"` — used by Task 4 when publishing `approval_request`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { assessRisk } from "../../src/approvals/risk";

describe("assessRisk", () => {
  test("classifies destructive/execution tools as high", () => {
    expect(assessRisk("Bash")).toBe("high");
    expect(assessRisk("Write")).toBe("high");
    expect(assessRisk("MultiEdit")).toBe("high");
    expect(assessRisk("NotebookEdit")).toBe("high");
  });

  test("classifies Edit as medium", () => {
    expect(assessRisk("Edit")).toBe("medium");
  });

  test("classifies read-only tools as low", () => {
    expect(assessRisk("Read")).toBe("low");
    expect(assessRisk("Glob")).toBe("low");
    expect(assessRisk("Grep")).toBe("low");
    expect(assessRisk("WebFetch")).toBe("low");
    expect(assessRisk("WebSearch")).toBe("low");
  });

  test("defaults unknown tools to medium", () => {
    expect(assessRisk("SomeFutureTool")).toBe("medium");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd daemon && bun test test/approvals/risk.test.ts`
Expected: FAIL — `Cannot find module '../../src/approvals/risk'`

- [ ] **Step 3: Write minimal implementation**

```ts
export type Risk = "low" | "medium" | "high";

const HIGH = new Set(["Bash", "Write", "MultiEdit", "NotebookEdit"]);
const MEDIUM = new Set(["Edit"]);
const LOW = new Set(["Read", "Glob", "Grep", "WebFetch", "WebSearch"]);

export function assessRisk(tool: string): Risk {
  if (HIGH.has(tool)) return "high";
  if (LOW.has(tool)) return "low";
  if (MEDIUM.has(tool)) return "medium";
  return "medium";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd daemon && bun test test/approvals/risk.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add daemon/src/approvals/risk.ts daemon/test/approvals/risk.test.ts
git commit -m "feat(daemon): add per-tool risk assessment for approval requests"
```

---

## Task 2: Approval registry

**Files:**
- Create: `daemon/src/approvals/approval-registry.ts`
- Test: `daemon/test/approvals/approval-registry.test.ts`

**Interfaces:**
- Consumes: nothing (pure, no deps).
- Produces: `class ApprovalRegistry { request(id: string, timeoutMs: number): Promise<"approve" | "reject">; respond(id: string, decision: "approve" | "reject"): boolean }` — used by Task 3/4 (hook-server + index.ts).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { ApprovalRegistry } from "../../src/approvals/approval-registry";

describe("ApprovalRegistry", () => {
  test("resolves with the responded decision", async () => {
    const registry = new ApprovalRegistry();
    const pending = registry.request("req-1", 5_000);
    const responded = registry.respond("req-1", "approve");
    expect(responded).toBe(true);
    expect(await pending).toBe("approve");
  });

  test("resolves with reject when responded with reject", async () => {
    const registry = new ApprovalRegistry();
    const pending = registry.request("req-2", 5_000);
    registry.respond("req-2", "reject");
    expect(await pending).toBe("reject");
  });

  test("respond returns false for an unknown id", () => {
    const registry = new ApprovalRegistry();
    expect(registry.respond("nonexistent", "approve")).toBe(false);
  });

  test("resolves with reject on timeout when nothing responds", async () => {
    const registry = new ApprovalRegistry();
    const pending = registry.request("req-3", 10);
    expect(await pending).toBe("reject");
  });

  test("a late respond after timeout is a no-op (returns false)", async () => {
    const registry = new ApprovalRegistry();
    const pending = registry.request("req-4", 10);
    expect(await pending).toBe("reject");
    expect(registry.respond("req-4", "approve")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd daemon && bun test test/approvals/approval-registry.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
export type ApprovalDecision = "approve" | "reject";

interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ApprovalRegistry {
  private pending = new Map<string, PendingApproval>();

  request(id: string, timeoutMs: number): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve("reject");
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
    });
  }

  respond(id: string, decision: ApprovalDecision): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.resolve(decision);
    return true;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd daemon && bun test test/approvals/approval-registry.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add daemon/src/approvals/approval-registry.ts daemon/test/approvals/approval-registry.test.ts
git commit -m "feat(daemon): add pending-approval registry with deny-on-timeout"
```

---

## Task 3: Hook server — async PreToolUse decision contract

**Files:**
- Modify: `daemon/src/hooks/hook-server.ts`
- Modify: `daemon/test/hooks/hook-server.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `HookServerOptions.onPreToolUse` changes from `(event) => void` to `(event: { worktreePath: string; tool: string; input: Record<string, unknown> }) => Promise<{ decision: "allow" | "deny"; reason: string }>`. `PreToolUse` requests now get a JSON body back instead of `"ok"`; `PostToolUse` is unchanged (still publishes and returns `"ok"`). Task 4 (`index.ts`) implements the new callback shape.

- [ ] **Step 1: Write the failing test**

Replace the existing `"invokes onPreToolUse for a PreToolUse payload"` test in `daemon/test/hooks/hook-server.test.ts` with:

```ts
  test("awaits onPreToolUse and returns its decision as hookSpecificOutput JSON", async () => {
    const bus = new EventBus<ServerMessage>();
    const received: ServerMessage[] = [];
    const preToolCalls: unknown[] = [];
    bus.subscribe((m) => received.push(m));
    server = startHookServer({
      port: 0,
      bus,
      onPreToolUse: async (event) => {
        preToolCalls.push(event);
        return { decision: "deny", reason: "test denial" };
      },
    });

    const response = await fetch(`http://127.0.0.1:${server.port}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hook_event_name: "PreToolUse",
        cwd: "/repo/feature-x",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      }),
    });

    expect(preToolCalls).toEqual([
      { worktreePath: "/repo/feature-x", tool: "Bash", input: { command: "ls" } },
    ]);
    expect(await response.json()).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "test denial",
      },
    });
    expect(received).toEqual([
      {
        type: "hook_event",
        hook: "PreToolUse",
        worktreePath: "/repo/feature-x",
        tool: "Bash",
        input: { command: "ls" },
        output: null,
      },
    ]);
  });

  test("PreToolUse with no onPreToolUse configured still returns ok", async () => {
    const bus = new EventBus<ServerMessage>();
    server = startHookServer({ port: 0, bus });

    const response = await fetch(`http://127.0.0.1:${server.port}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hook_event_name: "PreToolUse",
        cwd: "/repo/feature-x",
        tool_name: "Read",
        tool_input: {},
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd daemon && bun test test/hooks/hook-server.test.ts`
Expected: FAIL — old test's `onPreToolUse: (event) => preToolCalls.push(event)` shape no longer matches; new test expects JSON body but current code always returns `"ok"`.

- [ ] **Step 3: Write minimal implementation**

Replace `daemon/src/hooks/hook-server.ts` in full:

```ts
import type { ServerMessage } from "@wranglr/protocol";
import { z } from "zod";
import type { EventBus } from "../event-bus";

const HookPayloadSchema = z.object({
  hook_event_name: z.enum(["PreToolUse", "PostToolUse"]),
  cwd: z.string(),
  tool_name: z.string(),
  tool_input: z.record(z.string(), z.unknown()),
  tool_response: z.record(z.string(), z.unknown()).optional(),
});

export interface PreToolUseDecision {
  decision: "allow" | "deny";
  reason: string;
}

export interface HookServerOptions {
  port: number;
  bus: EventBus<ServerMessage>;
  onPreToolUse?: (event: {
    worktreePath: string;
    tool: string;
    input: Record<string, unknown>;
  }) => Promise<PreToolUseDecision>;
}

export function startHookServer(options: HookServerOptions): { stop: () => void; port: number } {
  const server = Bun.serve({
    port: options.port,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.method !== "POST" || new URL(req.url).pathname !== "/hook") {
        return new Response("not found", { status: 404 });
      }
      const body = await req.json().catch(() => null);
      const parsed = HookPayloadSchema.safeParse(body);
      if (!parsed.success) {
        return new Response("bad request", { status: 400 });
      }

      const { hook_event_name, cwd, tool_name, tool_input, tool_response } = parsed.data;

      options.bus.publish({
        type: "hook_event",
        hook: hook_event_name,
        worktreePath: cwd,
        tool: tool_name,
        input: tool_input,
        output: tool_response ?? null,
      });

      if (hook_event_name === "PreToolUse" && options.onPreToolUse) {
        const result = await options.onPreToolUse({ worktreePath: cwd, tool: tool_name, input: tool_input });
        return Response.json({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: result.decision,
            permissionDecisionReason: result.reason,
          },
        });
      }

      return new Response("ok");
    },
  });

  return { port: server.port as number, stop: () => server.stop(true) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd daemon && bun test test/hooks/hook-server.test.ts`
Expected: PASS (all tests, including the unchanged PostToolUse and 400 tests)

- [ ] **Step 5: Commit**

```bash
git add daemon/src/hooks/hook-server.ts daemon/test/hooks/hook-server.test.ts
git commit -m "feat(daemon): make PreToolUse hook handling async and return a real permission decision"
```

---

## Task 4: Wire approvals, risk, and push endpoints into the daemon entrypoint

**Files:**
- Modify: `daemon/src/index.ts`

**Interfaces:**
- Consumes: `ApprovalRegistry` (Task 2), `assessRisk` (Task 1), `PreToolUseDecision` (Task 3), `PushManager.addSubscription`/`vapidKeys.publicKey` (existing `web-push.ts`), `onPushSubscribe`/`onVapidPublicKeyRequest` (Task 5 — write this task's code first, then Task 5's ws-server change; the two are interdependent, see note below).
- Produces: nothing new for later tasks — this is the final glue task for the daemon-approval half.

This task has no new automated test (consistent with `index.ts` having none today — it's pure wiring of already-tested units). Verification is a live manual test, same discipline used for the original daemon build's Task 11.

- [ ] **Step 1: Replace the `onClientMessage` function and hook wiring**

In `daemon/src/index.ts`, add imports:

```ts
import { ApprovalRegistry } from "./approvals/approval-registry";
import { assessRisk } from "./approvals/risk";
```

Replace the `onClientMessage` function (currently lines 49-57) with:

```ts
const approvalRegistry = new ApprovalRegistry();

function onClientMessage(msg: ClientMessage): void {
  if (msg.type === "prompt") {
    const session = latestSessions.find((s) => s.cwd === msg.worktreePath);
    if (session) void herdrAdapter.sendKeys(session.paneId, [msg.text, "Enter"]);
  } else if (msg.type === "approval_response") {
    approvalRegistry.respond(msg.id, msg.decision);
  }
}
```

Replace the `startHookServer({...})` call (currently lines 59-68) with:

```ts
startHookServer({
  port: HOOK_PORT,
  bus,
  onPreToolUse: async ({ worktreePath, tool, input }) => {
    const policyDecision = decide(policyConfig, worktreePath, tool);
    if (policyDecision === "allow") {
      return { decision: "allow", reason: "Auto-allowed by policy" };
    }
    if (policyDecision === "block") {
      return { decision: "deny", reason: "Blocked by policy" };
    }

    const id = crypto.randomUUID();
    bus.publish({
      type: "approval_request",
      id,
      worktreePath,
      tool,
      input,
      risk: assessRisk(tool),
    });
    void pushManager.notifyAll({ title: "Wranglr", body: `${tool} awaiting approval in ${worktreePath}` });

    const approvalDecision = await approvalRegistry.request(id, 120_000);
    return approvalDecision === "approve"
      ? { decision: "allow", reason: "Approved via Wranglr" }
      : { decision: "deny", reason: "Denied (no response within 120s)" };
  },
});
```

- [ ] **Step 2: Run the full daemon test suite to confirm nothing broke**

Run: `cd daemon && bun test`
Expected: PASS, same test count as before this task (no new tests added here)

- [ ] **Step 3: Manual live verification**

With a real Herdr session running and `~/.config/wranglr/policy.json` mapping this repo to `"guarded"`:

1. Start the daemon: `WRANGLR_TOKEN=test bun daemon/src/index.ts`
2. In another terminal, send a fake `PreToolUse` request for a guarded tool and time it:
   ```bash
   time curl -s -X POST http://127.0.0.1:7421/hook \
     -H "content-type: application/json" \
     -d '{"hook_event_name":"PreToolUse","cwd":"'"$(pwd)"'","tool_name":"Bash","tool_input":{"command":"echo hi"}}'
   ```
3. Confirm it hangs, then after 120s returns `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Denied (no response within 120s)"}}` and `real` time is ~120s.
4. Repeat, but this time connect a WS client (`wscat -c "ws://127.0.0.1:7420/?token=test"`), read the `approval_request` message it receives, and send back `{"type":"approval_response","id":"<the id from the message>","decision":"approve"}` before the timeout. Confirm the curl in step 2 returns immediately with `permissionDecision: "allow"`.

- [ ] **Step 4: Commit**

```bash
git add daemon/src/index.ts
git commit -m "feat(daemon): wire PreToolUse decisions through the approval registry"
```

---

## Task 5: Push-subscription and VAPID public key HTTP endpoints

**Files:**
- Modify: `daemon/src/ws-server.ts`
- Modify: `daemon/test/ws-server.test.ts`
- Modify: `daemon/src/index.ts` (pass the two new callbacks/values into `startWsServer`)

**Interfaces:**
- Consumes: `PushManager.addSubscription(sub)`, `vapidKeys.publicKey` (existing, from `web-push.ts`).
- Produces: `WsServerOptions` gains `onPushSubscribe: (sub: { endpoint: string; keys: { p256dh: string; auth: string } }) => void` and `vapidPublicKey: string`. Used by Task 17 (PWA push registration) as the HTTP contract it calls.

- [ ] **Step 1: Write the failing test**

Add to `daemon/test/ws-server.test.ts` (check existing imports/helpers in that file first and reuse them — it already has a pattern for starting a server with a token and making HTTP requests against it):

```ts
  test("POST /push-subscribe with a valid token calls onPushSubscribe and returns 204", async () => {
    const bus = new EventBus<ServerMessage>();
    const received: unknown[] = [];
    server = startWsServer({
      token: "tok",
      hostname: "127.0.0.1",
      port: 0,
      bus,
      onClientMessage: () => {},
      getSnapshot: () => [],
      onPushSubscribe: (sub) => received.push(sub),
      vapidPublicKey: "test-public-key",
    });

    const response = await fetch(`http://127.0.0.1:${server.port}/push-subscribe?token=tok`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "https://push.example/1", keys: { p256dh: "a", auth: "b" } }),
    });

    expect(response.status).toBe(204);
    expect(received).toEqual([{ endpoint: "https://push.example/1", keys: { p256dh: "a", auth: "b" } }]);
  });

  test("POST /push-subscribe with a bad token returns 401", async () => {
    const bus = new EventBus<ServerMessage>();
    server = startWsServer({
      token: "tok",
      hostname: "127.0.0.1",
      port: 0,
      bus,
      onClientMessage: () => {},
      getSnapshot: () => [],
      onPushSubscribe: () => {},
      vapidPublicKey: "test-public-key",
    });

    const response = await fetch(`http://127.0.0.1:${server.port}/push-subscribe?token=wrong`, {
      method: "POST",
      body: JSON.stringify({ endpoint: "x", keys: { p256dh: "a", auth: "b" } }),
    });

    expect(response.status).toBe(401);
  });

  test("GET /vapid-public-key with a valid token returns the key", async () => {
    const bus = new EventBus<ServerMessage>();
    server = startWsServer({
      token: "tok",
      hostname: "127.0.0.1",
      port: 0,
      bus,
      onClientMessage: () => {},
      getSnapshot: () => [],
      onPushSubscribe: () => {},
      vapidPublicKey: "test-public-key",
    });

    const response = await fetch(`http://127.0.0.1:${server.port}/vapid-public-key?token=tok`);

    expect(await response.json()).toEqual({ publicKey: "test-public-key" });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd daemon && bun test test/ws-server.test.ts`
Expected: FAIL — `onPushSubscribe`/`vapidPublicKey` not in `WsServerOptions`, routes don't exist (404s instead of 204/200)

- [ ] **Step 3: Write minimal implementation**

In `daemon/src/ws-server.ts`, extend `WsServerOptions`:

```ts
export interface WsServerOptions {
  token: string;
  hostname: string;
  port: number;
  bus: EventBus<ServerMessage>;
  onClientMessage: (msg: ClientMessage) => void;
  getSnapshot: () => ServerMessage[];
  onPushSubscribe: (sub: { endpoint: string; keys: { p256dh: string; auth: string } }) => void;
  vapidPublicKey: string;
  heartbeatIntervalMs?: number;
}
```

Replace the `fetch` handler's body (keep the `websocket` block below it unchanged):

```ts
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.searchParams.get("token") !== options.token) {
        return new Response("unauthorized", { status: 401 });
      }

      if (req.method === "POST" && url.pathname === "/push-subscribe") {
        return req.json().then((body) => {
          options.onPushSubscribe(body as { endpoint: string; keys: { p256dh: string; auth: string } });
          return new Response(null, { status: 204 });
        });
      }

      if (req.method === "GET" && url.pathname === "/vapid-public-key") {
        return Response.json({ publicKey: options.vapidPublicKey });
      }

      const upgraded = srv.upgrade(req);
      if (!upgraded) return new Response("upgrade failed", { status: 400 });
      return undefined as unknown as Response;
    },
```

In `daemon/src/index.ts`, update the `startWsServer({...})` call to add:

```ts
  onPushSubscribe: (sub) => pushManager.addSubscription(sub),
  vapidPublicKey: pushManager.vapidPublicKey,
```

This requires exposing the public key from `PushManager`. In `daemon/src/push/web-push.ts`, add a getter to the `PushManager` class:

```ts
  private publicKey: string;
```

and set it in the constructor (`this.publicKey = vapidKeys.publicKey;`), then add:

```ts
  get vapidPublicKey(): string {
    return this.publicKey;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd daemon && bun test`
Expected: PASS, all suites including `ws-server.test.ts` and `push/web-push.test.ts`

- [ ] **Step 5: Commit**

```bash
git add daemon/src/ws-server.ts daemon/test/ws-server.test.ts daemon/src/index.ts daemon/src/push/web-push.ts
git commit -m "feat(daemon): add push-subscribe and vapid-public-key HTTP endpoints"
```

---

## Task 6: QR pairing payload + startup printout

**Files:**
- Create: `daemon/src/pairing/pairing-payload.ts`
- Test: `daemon/test/pairing/pairing-payload.test.ts`
- Modify: `daemon/package.json` (+ `qrcode-terminal` dependency)
- Modify: `daemon/src/index.ts` (print QR at startup)

**Interfaces:**
- Produces: `buildPairingPayload(hostname: string, port: number, token: string): string` — a JSON string, used by `index.ts` here and mirrored by the PWA's `parsePairingPayload` in Task 11 (same JSON shape: `{hostname, port, token}`).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { buildPairingPayload } from "../../src/pairing/pairing-payload";

describe("buildPairingPayload", () => {
  test("serializes hostname, port, and token as JSON", () => {
    const payload = buildPairingPayload("100.64.1.2", 7420, "secret-token");
    expect(JSON.parse(payload)).toEqual({ hostname: "100.64.1.2", port: 7420, token: "secret-token" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd daemon && bun test test/pairing/pairing-payload.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
export function buildPairingPayload(hostname: string, port: number, token: string): string {
  return JSON.stringify({ hostname, port, token });
}
```

Add the dependency:

```bash
cd daemon && bun add qrcode-terminal && bun add -d @types/qrcode-terminal
```

If `@types/qrcode-terminal` doesn't exist on npm, skip it and add a local declaration instead — create `daemon/src/qrcode-terminal.d.ts`:

```ts
declare module "qrcode-terminal" {
  export function generate(input: string, options?: { small?: boolean }, callback?: (qrcode: string) => void): void;
}
```

In `daemon/src/index.ts`, add the import:

```ts
import qrcode from "qrcode-terminal";
import { buildPairingPayload } from "./pairing/pairing-payload";
```

At the end of the file, after the existing `console.log(...)` startup line, add:

```ts
console.log("Scan to pair the Wranglr PWA:");
qrcode.generate(buildPairingPayload(TAILSCALE_HOSTNAME, WS_PORT, TOKEN), { small: true });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd daemon && bun test test/pairing/pairing-payload.test.ts`
Expected: PASS

- [ ] **Step 5: Manual verification**

Run `WRANGLR_TOKEN=test bun daemon/src/index.ts`, confirm a scannable QR prints to the terminal below the startup log line.

- [ ] **Step 6: Commit**

```bash
git add daemon/src/pairing/pairing-payload.ts daemon/test/pairing/pairing-payload.test.ts daemon/src/index.ts daemon/package.json daemon/bun.lock daemon/src/qrcode-terminal.d.ts
git commit -m "feat(daemon): print a pairing QR code on startup"
```

---

## Task 7: Hook script + `.claude/settings.json` wiring

**Files:**
- Create: `daemon/scripts/hook.sh`
- Create: `.claude/settings.json` (repo root)

**Interfaces:** none (shell glue + config, no code interfaces).

- [ ] **Step 1: Write the hook script**

```bash
#!/usr/bin/env bash
set -euo pipefail

HOOK_INPUT="$(cat)"
PORT="${WRANGLR_HOOK_PORT:-7421}"

curl -s -X POST "http://127.0.0.1:${PORT}/hook" \
  -H "Content-Type: application/json" \
  -d "$HOOK_INPUT"

exit 0
```

Make it executable:

```bash
chmod +x daemon/scripts/hook.sh
```

- [ ] **Step 2: Write `.claude/settings.json`**

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "daemon/scripts/hook.sh",
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
            "command": "daemon/scripts/hook.sh",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 3: Manual verification (this dogfoods on the wranglr repo itself — read carefully before running)**

This step wires real Claude Code hooks for the wranglr repo, live, in whatever Claude Code session runs it. Before running: set `~/.config/wranglr/policy.json`'s entry for this repo's absolute path to `"guarded"` temporarily if you want to see a real block; leave it `"experimental"` if you'd rather only see `Read`/`Edit` auto-allow and everything else ask.

1. Start the daemon: `WRANGLR_TOKEN=<token> bun daemon/src/index.ts` (use the same token your PWA/test WS client will use).
2. In a **separate** Claude Code session rooted at this repo, ask it to run a shell command (triggers `Bash`, which is never auto-allowed).
3. Confirm the tool call visibly hangs (Claude Code shows its own "waiting on hook" state) and, if you send an `approval_response` with `decision: "approve"` over a WS client connected to the daemon within 120s, the command actually executes. If you let it time out, confirm Claude Code reports the tool call as blocked/denied.
4. Confirm `PostToolUse` events still show up in a WS client's message stream (unaffected — no decision required, so it should never block).

- [ ] **Step 4: Commit**

```bash
git add daemon/scripts/hook.sh .claude/settings.json
git commit -m "feat: wire Claude Code PreToolUse/PostToolUse hooks to the wranglr daemon"
```

---

## Task 8: Scaffold the PWA package

**Files:**
- Create: `pwa/package.json`
- Create: `pwa/tsconfig.json`
- Create: `pwa/next.config.ts`
- Create: `pwa/bunfig.toml`
- Create: `pwa/test-setup.ts`
- Create: `pwa/app/layout.tsx`
- Create: `pwa/app/page.tsx`
- Create: `pwa/public/manifest.json`
- Test: `pwa/app/page.test.tsx`
- Modify: root `package.json` (+ `"pwa"` workspace)

**Interfaces:**
- Produces: the `pwa/` package itself, a working `bun test` + `@testing-library/react` setup that every later PWA task's component tests rely on.

- [ ] **Step 1: Create the package files**

`pwa/package.json`:

```json
{
  "name": "@wranglr/pwa",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "test": "bun test"
  },
  "dependencies": {
    "@wranglr/protocol": "workspace:*"
  }
}
```

Then install current versions of everything else rather than hand-pinning versions in the JSON above (avoids shipping a plan with version numbers that are stale by the time it's executed — same reasoning as Task 6's `qrcode-terminal` install):

```bash
cd pwa
bun add next react react-dom jsqr
bun add -d @types/react @types/react-dom typescript @happy-dom/global-registrator @testing-library/react @testing-library/jest-dom
```

`pwa/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["dom", "dom.iterable", "esnext"],
    "jsx": "react-jsx",
    "module": "esnext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "noEmit": true,
    "paths": { "@/*": ["./*"] }
  },
  "include": ["**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules"]
}
```

`pwa/next.config.ts`:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
};

export default nextConfig;
```

`pwa/bunfig.toml`:

```toml
[test]
preload = ["./test-setup.ts"]
```

`pwa/test-setup.ts`:

```ts
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
```

`pwa/public/manifest.json`:

```json
{
  "name": "Wranglr",
  "short_name": "Wranglr",
  "start_url": "/dashboard",
  "display": "standalone",
  "background_color": "#111111",
  "theme_color": "#111111",
  "icons": []
}
```

`pwa/app/layout.tsx`:

```tsx
import type { ReactNode } from "react";

export const metadata = {
  title: "Wranglr",
  manifest: "/manifest.json",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

`pwa/app/page.tsx` (placeholder redirect target — real redirect logic lands in Task 15 once pairing storage exists; for now it just renders a static landing marker so the smoke test has something to assert on):

```tsx
export default function Home() {
  return <main>Wranglr</main>;
}
```

- [ ] **Step 2: Write the smoke test**

`pwa/app/page.test.tsx`:

```tsx
/// <reference lib="dom" />
import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import Home from "./page";

describe("Home", () => {
  test("renders the app name", () => {
    render(<Home />);
    expect(screen.getByText("Wranglr")).toBeTruthy();
  });
});
```

- [ ] **Step 3: Update root `package.json`**

```json
{
  "name": "wranglr",
  "private": true,
  "workspaces": ["daemon", "packages/*", "pwa"]
}
```

- [ ] **Step 4: Install and run the test**

Run: `bun install && cd pwa && bun test`
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
git add pwa package.json bun.lock
git commit -m "feat(pwa): scaffold Next.js static-export app with component test setup"
```

---

## Task 9: WebSocket client

**Files:**
- Create: `pwa/lib/ws-client.ts`
- Test: `pwa/lib/ws-client.test.ts`

**Interfaces:**
- Consumes: `ServerMessage`, `ClientMessage`, `ServerMessageSchema` from `@wranglr/protocol`.
- Produces:
  ```ts
  export type ConnectionStatus = "connecting" | "open" | "closed";
  export class WranglrWsClient {
    constructor(url: string, handlers: {
      onMessage: (msg: ServerMessage) => void;
      onStatusChange: (status: ConnectionStatus) => void;
    });
    send(msg: ClientMessage): void;
    close(): void;
  }
  ```
  Used by Task 10 (`store.tsx`) as the transport the reducer's provider owns.

- [ ] **Step 1: Write the failing test**

```ts
/// <reference lib="dom" />
import { describe, expect, test, afterEach } from "bun:test";
import { WranglrWsClient, type ConnectionStatus } from "./ws-client";
import type { ServerMessage } from "@wranglr/protocol";

let servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(() => {
  for (const s of servers) s.stop(true);
  servers = [];
});

function startFakeServer(onMessage?: (raw: string) => void) {
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined as unknown as Response;
      return new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ type: "worktree_status", worktrees: [] }));
      },
      message(_ws, raw) {
        onMessage?.(String(raw));
      },
      close() {},
    },
  });
  servers.push(server);
  return server;
}

describe("WranglrWsClient", () => {
  test("reports connecting then open, and delivers a parsed ServerMessage", async () => {
    const server = startFakeServer();
    const statuses: ConnectionStatus[] = [];
    const messages: ServerMessage[] = [];

    const client = new WranglrWsClient(`ws://127.0.0.1:${server.port}`, {
      onMessage: (msg) => messages.push(msg),
      onStatusChange: (status) => statuses.push(status),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(statuses).toEqual(["connecting", "open"]);
    expect(messages).toEqual([{ type: "worktree_status", worktrees: [] }]);

    client.close();
  });

  test("send() serializes a ClientMessage over the socket", async () => {
    const received: string[] = [];
    const server = startFakeServer((raw) => received.push(raw));

    const client = new WranglrWsClient(`ws://127.0.0.1:${server.port}`, {
      onMessage: () => {},
      onStatusChange: () => {},
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    client.send({ type: "prompt", worktreePath: "/repo", text: "hi" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toEqual([JSON.stringify({ type: "prompt", worktreePath: "/repo", text: "hi" })]);
    client.close();
  });

  test("reports closed after close()", async () => {
    const server = startFakeServer();
    const statuses: ConnectionStatus[] = [];

    const client = new WranglrWsClient(`ws://127.0.0.1:${server.port}`, {
      onMessage: () => {},
      onStatusChange: (status) => statuses.push(status),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    client.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(statuses).toEqual(["connecting", "open", "closed"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pwa && bun test lib/ws-client.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
import { ServerMessageSchema, type ClientMessage, type ServerMessage } from "@wranglr/protocol";

export type ConnectionStatus = "connecting" | "open" | "closed";

export interface WranglrWsClientHandlers {
  onMessage: (msg: ServerMessage) => void;
  onStatusChange: (status: ConnectionStatus) => void;
}

export class WranglrWsClient {
  private socket: WebSocket;
  private closedByUser = false;

  constructor(url: string, private handlers: WranglrWsClientHandlers) {
    handlers.onStatusChange("connecting");
    this.socket = new WebSocket(url);

    this.socket.addEventListener("open", () => handlers.onStatusChange("open"));
    this.socket.addEventListener("close", () => {
      if (!this.closedByUser) handlers.onStatusChange("closed");
    });
    this.socket.addEventListener("message", (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const result = ServerMessageSchema.safeParse(parsed);
      if (result.success) handlers.onMessage(result.data);
    });
  }

  send(msg: ClientMessage): void {
    this.socket.send(JSON.stringify(msg));
  }

  close(): void {
    this.closedByUser = true;
    this.socket.close();
    this.handlers.onStatusChange("closed");
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pwa && bun test lib/ws-client.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add pwa/lib/ws-client.ts pwa/lib/ws-client.test.ts
git commit -m "feat(pwa): add typed WebSocket client"
```

---

## Task 10: State store (Context + useReducer)

**Files:**
- Create: `pwa/lib/store.tsx`
- Test: `pwa/lib/store.test.tsx`

**Interfaces:**
- Consumes: `ServerMessage`, `ClientMessage` from `@wranglr/protocol`; `WranglrWsClient`, `ConnectionStatus` from Task 9.
- Produces:
  ```ts
  export interface WorktreeStatus { path: string; herdrPaneId: string | null; state: "idle"|"working"|"blocked"|"done"|"unknown" }
  export interface PendingApproval { id: string; worktreePath: string; tool: string; input: Record<string, unknown>; risk: "low"|"medium"|"high" }
  export interface WranglrState {
    connectionStatus: ConnectionStatus;
    worktrees: WorktreeStatus[];
    hookEvents: Array<Extract<ServerMessage, { type: "hook_event" }>>;
    pendingApprovals: PendingApproval[];
  }
  export function reducer(state: WranglrState, action: ServerMessage | { type: "connection_status"; status: ConnectionStatus }): WranglrState;
  export const initialState: WranglrState;
  export function WranglrProvider(props: { url: string; children: ReactNode }): JSX.Element;
  export function useWranglr(): { state: WranglrState; send: (msg: ClientMessage) => void };
  ```
  Used by every screen task (12-16) via `useWranglr()`.

- [ ] **Step 1: Write the failing test**

```ts
/// <reference lib="dom" />
import { describe, expect, test } from "bun:test";
import { reducer, initialState } from "./store";

describe("reducer", () => {
  test("connection_status updates connectionStatus", () => {
    const next = reducer(initialState, { type: "connection_status", status: "open" });
    expect(next.connectionStatus).toBe("open");
  });

  test("worktree_status replaces the worktrees list", () => {
    const next = reducer(initialState, {
      type: "worktree_status",
      worktrees: [{ path: "/repo/a", herdrPaneId: "p1", state: "working" }],
    });
    expect(next.worktrees).toEqual([{ path: "/repo/a", herdrPaneId: "p1", state: "working" }]);
  });

  test("hook_event appends to the hookEvents log", () => {
    const event = { type: "hook_event" as const, hook: "PreToolUse" as const, worktreePath: "/repo/a", tool: "Bash", input: {}, output: null };
    const next = reducer(initialState, event);
    expect(next.hookEvents).toEqual([event]);
  });

  test("approval_request appends to pendingApprovals", () => {
    const request = { type: "approval_request" as const, id: "1", worktreePath: "/repo/a", tool: "Bash", input: {}, risk: "high" as const };
    const next = reducer(initialState, request);
    expect(next.pendingApprovals).toEqual([{ id: "1", worktreePath: "/repo/a", tool: "Bash", input: {}, risk: "high" }]);
  });

  test("approval_request followed by resolving it removes it once a matching response would be sent (pendingApprovals only tracks requests; removal happens via a dedicated action)", () => {
    const request = { type: "approval_request" as const, id: "1", worktreePath: "/repo/a", tool: "Bash", input: {}, risk: "high" as const };
    const withRequest = reducer(initialState, request);
    const cleared = reducer(withRequest, { type: "connection_status", status: "closed" });
    expect(cleared.pendingApprovals).toEqual([{ id: "1", worktreePath: "/repo/a", tool: "Bash", input: {}, risk: "high" }]);
  });
});
```

Note on that last test: it documents (not enforces removal) that `pendingApprovals` entries are cleared by the UI dispatching a local removal, not by the reducer inferring it from an outgoing message. Add a sixth test for the actual removal action:

```ts
  test("approval_resolved removes a pending approval by id", () => {
    const request = { type: "approval_request" as const, id: "1", worktreePath: "/repo/a", tool: "Bash", input: {}, risk: "high" as const };
    const withRequest = reducer(initialState, request);
    const cleared = reducer(withRequest, { type: "approval_resolved", id: "1" });
    expect(cleared.pendingApprovals).toEqual([]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pwa && bun test lib/store.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```tsx
import { createContext, useContext, useEffect, useReducer, useRef, type ReactNode } from "react";
import type { ClientMessage, ServerMessage } from "@wranglr/protocol";
import { WranglrWsClient, type ConnectionStatus } from "./ws-client";

export interface WorktreeStatus {
  path: string;
  herdrPaneId: string | null;
  state: "idle" | "working" | "blocked" | "done" | "unknown";
}

export interface PendingApproval {
  id: string;
  worktreePath: string;
  tool: string;
  input: Record<string, unknown>;
  risk: "low" | "medium" | "high";
}

export interface WranglrState {
  connectionStatus: ConnectionStatus;
  worktrees: WorktreeStatus[];
  hookEvents: Array<Extract<ServerMessage, { type: "hook_event" }>>;
  pendingApprovals: PendingApproval[];
}

export const initialState: WranglrState = {
  connectionStatus: "connecting",
  worktrees: [],
  hookEvents: [],
  pendingApprovals: [],
};

export type WranglrAction =
  | ServerMessage
  | { type: "connection_status"; status: ConnectionStatus }
  | { type: "approval_resolved"; id: string };

const HOOK_EVENT_LOG_LIMIT = 200;

export function reducer(state: WranglrState, action: WranglrAction): WranglrState {
  switch (action.type) {
    case "connection_status":
      return { ...state, connectionStatus: action.status };
    case "worktree_status":
      return { ...state, worktrees: action.worktrees };
    case "hook_event":
      return { ...state, hookEvents: [...state.hookEvents, action].slice(-HOOK_EVENT_LOG_LIMIT) };
    case "approval_request":
      return {
        ...state,
        pendingApprovals: [
          ...state.pendingApprovals,
          { id: action.id, worktreePath: action.worktreePath, tool: action.tool, input: action.input, risk: action.risk },
        ],
      };
    case "approval_resolved":
      return { ...state, pendingApprovals: state.pendingApprovals.filter((a) => a.id !== action.id) };
    case "verification_result":
      return state;
    default:
      return state;
  }
}

interface WranglrContextValue {
  state: WranglrState;
  send: (msg: ClientMessage) => void;
}

const WranglrContext = createContext<WranglrContextValue | null>(null);

export function WranglrProvider({ url, children }: { url: string; children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const clientRef = useRef<WranglrWsClient | null>(null);

  useEffect(() => {
    const client = new WranglrWsClient(url, {
      onMessage: (msg) => dispatch(msg),
      onStatusChange: (status) => dispatch({ type: "connection_status", status }),
    });
    clientRef.current = client;
    return () => client.close();
  }, [url]);

  const send = (msg: ClientMessage) => clientRef.current?.send(msg);

  return <WranglrContext.Provider value={{ state, send }}>{children}</WranglrContext.Provider>;
}

export function useWranglr(): WranglrContextValue {
  const ctx = useContext(WranglrContext);
  if (!ctx) throw new Error("useWranglr must be used within a WranglrProvider");
  return ctx;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pwa && bun test lib/store.test.tsx`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add pwa/lib/store.tsx pwa/lib/store.test.tsx
git commit -m "feat(pwa): add Context+useReducer state store"
```

---

## Task 11: Pairing storage + payload parsing

**Files:**
- Create: `pwa/lib/pairing.ts`
- Test: `pwa/lib/pairing.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PairingInfo { hostname: string; port: number; token: string }
  export function savePairing(info: PairingInfo): void;
  export function loadPairing(): PairingInfo | null;
  export function clearPairing(): void;
  export function parsePairingPayload(text: string): PairingInfo | null;
  export function wsUrl(info: PairingInfo): string;
  ```
  Used by Task 12 (manual entry), Task 13 (QR scan), Task 15 (dashboard's redirect-if-unpaired check), Task 10's consumers (whoever builds the `url` passed to `WranglrProvider`).

- [ ] **Step 1: Write the failing test**

```ts
/// <reference lib="dom" />
import { describe, expect, test, beforeEach } from "bun:test";
import { savePairing, loadPairing, clearPairing, parsePairingPayload, wsUrl } from "./pairing";

beforeEach(() => {
  localStorage.clear();
});

describe("pairing storage", () => {
  test("round-trips through localStorage", () => {
    expect(loadPairing()).toBeNull();
    savePairing({ hostname: "100.64.1.2", port: 7420, token: "tok" });
    expect(loadPairing()).toEqual({ hostname: "100.64.1.2", port: 7420, token: "tok" });
  });

  test("clearPairing removes it", () => {
    savePairing({ hostname: "100.64.1.2", port: 7420, token: "tok" });
    clearPairing();
    expect(loadPairing()).toBeNull();
  });

  test("loadPairing returns null for malformed stored JSON", () => {
    localStorage.setItem("wranglr.pairing", "not json");
    expect(loadPairing()).toBeNull();
  });
});

describe("parsePairingPayload", () => {
  test("parses a valid QR payload", () => {
    const payload = JSON.stringify({ hostname: "100.64.1.2", port: 7420, token: "tok" });
    expect(parsePairingPayload(payload)).toEqual({ hostname: "100.64.1.2", port: 7420, token: "tok" });
  });

  test("returns null for invalid JSON", () => {
    expect(parsePairingPayload("garbage")).toBeNull();
  });

  test("returns null when required fields are missing", () => {
    expect(parsePairingPayload(JSON.stringify({ hostname: "x" }))).toBeNull();
  });
});

describe("wsUrl", () => {
  test("builds a ws:// url with the token as a query param", () => {
    expect(wsUrl({ hostname: "100.64.1.2", port: 7420, token: "tok" })).toBe("ws://100.64.1.2:7420/?token=tok");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pwa && bun test lib/pairing.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
import { z } from "zod";

export interface PairingInfo {
  hostname: string;
  port: number;
  token: string;
}

const PairingSchema = z.object({
  hostname: z.string(),
  port: z.number(),
  token: z.string(),
});

const STORAGE_KEY = "wranglr.pairing";

export function savePairing(info: PairingInfo): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(info));
}

export function loadPairing(): PairingInfo | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = PairingSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function clearPairing(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function parsePairingPayload(text: string): PairingInfo | null {
  try {
    const parsed = PairingSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function wsUrl(info: PairingInfo): string {
  return `ws://${info.hostname}:${info.port}/?token=${info.token}`;
}
```

`zod` isn't currently a `pwa` dependency — add it:

```bash
cd pwa && bun add zod
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pwa && bun test lib/pairing.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add pwa/lib/pairing.ts pwa/lib/pairing.test.ts pwa/package.json bun.lock
git commit -m "feat(pwa): add pairing storage and QR payload parsing"
```

---

## Task 12: Pairing screen — manual entry

**Files:**
- Create: `pwa/app/pair/page.tsx`
- Test: `pwa/app/pair/page.test.tsx`

**Interfaces:**
- Consumes: `savePairing`, `PairingInfo` (Task 11).
- Produces: a form component; no exports consumed by later tasks beyond its route path `/pair`, which Task 15's redirect logic links to.

This is a client component (uses `useState`/`localStorage`) and needs `"use client"`.

- [ ] **Step 1: Write the failing test**

```tsx
/// <reference lib="dom" />
import { describe, expect, test, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import PairPage from "./page";
import { loadPairing } from "../../lib/pairing";

beforeEach(() => {
  localStorage.clear();
});

describe("PairPage", () => {
  test("saves entered hostname/port/token to pairing storage on submit", () => {
    render(<PairPage />);

    fireEvent.change(screen.getByLabelText("Hostname"), { target: { value: "100.64.1.2" } });
    fireEvent.change(screen.getByLabelText("Port"), { target: { value: "7420" } });
    fireEvent.change(screen.getByLabelText("Token"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Pair" }));

    expect(loadPairing()).toEqual({ hostname: "100.64.1.2", port: 7420, token: "secret" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pwa && bun test app/pair/page.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```tsx
"use client";

import { useState, type FormEvent } from "react";
import { savePairing } from "../../lib/pairing";

export default function PairPage() {
  const [hostname, setHostname] = useState("");
  const [port, setPort] = useState("7420");
  const [token, setToken] = useState("");

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    savePairing({ hostname, port: Number(port), token });
    window.location.href = "/dashboard";
  }

  return (
    <main>
      <h1>Pair with your daemon</h1>
      <form onSubmit={handleSubmit}>
        <label htmlFor="hostname">Hostname</label>
        <input id="hostname" value={hostname} onChange={(e) => setHostname(e.target.value)} />

        <label htmlFor="port">Port</label>
        <input id="port" value={port} onChange={(e) => setPort(e.target.value)} />

        <label htmlFor="token">Token</label>
        <input id="token" value={token} onChange={(e) => setToken(e.target.value)} />

        <button type="submit">Pair</button>
      </form>
      <a href="/pair/scan">Scan QR instead</a>
    </main>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pwa && bun test app/pair/page.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pwa/app/pair/page.tsx pwa/app/pair/page.test.tsx
git commit -m "feat(pwa): add manual pairing entry screen"
```

---

## Task 13: Pairing screen — QR scan

**Files:**
- Create: `pwa/app/pair/scan/page.tsx`

**Interfaces:**
- Consumes: `parsePairingPayload`, `savePairing` (Task 11).
- Produces: route `/pair/scan`, linked from Task 12's page.

Camera access (`getUserMedia`) is not available in `happy-dom` — this task has no automated test. The pure parsing logic it depends on (`parsePairingPayload`) is already fully tested in Task 11. Verification is manual (Step 3).

- [ ] **Step 1: Write the component**

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { parsePairingPayload, savePairing } from "../../../lib/pairing";

export default function ScanPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let rafId: number;
    let stopped = false;

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      } catch {
        setError("Camera access denied or unavailable.");
        return;
      }
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas) return;
      video.srcObject = stream;
      await video.play();

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      function tick() {
        if (stopped || !video || !canvas || !ctx) return;
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(imageData.data, imageData.width, imageData.height);
          if (code) {
            const info = parsePairingPayload(code.data);
            if (info) {
              savePairing(info);
              window.location.href = "/dashboard";
              return;
            }
          }
        }
        rafId = requestAnimationFrame(tick);
      }
      rafId = requestAnimationFrame(tick);
    }

    start();

    return () => {
      stopped = true;
      if (rafId) cancelAnimationFrame(rafId);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  return (
    <main>
      <h1>Scan pairing QR code</h1>
      {error && <p role="alert">{error}</p>}
      <video ref={videoRef} muted playsInline />
      <canvas ref={canvasRef} style={{ display: "none" }} />
      <a href="/pair">Enter manually instead</a>
    </main>
  );
}
```

- [ ] **Step 2: Manual verification**

Run `cd pwa && bun run dev`, open `/pair/scan` on a phone (or a laptop with a webcam) over HTTPS or `localhost` (camera access requires a secure context), point it at the daemon's printed QR from Task 6, confirm it redirects to `/dashboard` and `loadPairing()` (check via devtools) matches the daemon's actual hostname/port/token.

- [ ] **Step 3: Commit**

```bash
git add pwa/app/pair/scan/page.tsx
git commit -m "feat(pwa): add QR-scan pairing screen"
```

---

## Task 14: Root layout wiring + connection status indicator

**Files:**
- Modify: `pwa/app/layout.tsx`
- Create: `pwa/components/ConnectionBadge.tsx`
- Test: `pwa/components/ConnectionBadge.test.tsx`

**Interfaces:**
- Consumes: `useWranglr` (Task 10).
- Produces: `<ConnectionBadge />`, rendered in the root layout so it's visible on every screen (Tasks 15-16 don't need to render it themselves).

- [ ] **Step 1: Write the failing test**

```tsx
/// <reference lib="dom" />
import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { ConnectionBadge } from "./ConnectionBadge";
import { WranglrContext } from "../lib/store";
import type { WranglrState } from "../lib/store";

function renderWithStatus(status: WranglrState["connectionStatus"]) {
  const state: WranglrState = { connectionStatus: status, worktrees: [], hookEvents: [], pendingApprovals: [] };
  render(
    <WranglrContext.Provider value={{ state, send: () => {} }}>
      <ConnectionBadge />
    </WranglrContext.Provider>,
  );
}

describe("ConnectionBadge", () => {
  test("shows Connected when open", () => {
    renderWithStatus("open");
    expect(screen.getByText("Connected")).toBeTruthy();
  });

  test("shows Connecting… when connecting", () => {
    renderWithStatus("connecting");
    expect(screen.getByText("Connecting…")).toBeTruthy();
  });

  test("shows Disconnected when closed", () => {
    renderWithStatus("closed");
    expect(screen.getByText("Disconnected")).toBeTruthy();
  });
});
```

This test needs `WranglrContext` exported from `store.tsx` (it currently isn't — the module keeps it private). Update `pwa/lib/store.tsx`'s `const WranglrContext = createContext<WranglrContextValue | null>(null);` line to `export const WranglrContext = ...` and export the `WranglrContextValue` interface too (`export interface WranglrContextValue { ... }`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pwa && bun test components/ConnectionBadge.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```tsx
"use client";

import { useWranglr } from "../lib/store";

const LABELS = {
  connecting: "Connecting…",
  open: "Connected",
  closed: "Disconnected",
} as const;

export function ConnectionBadge() {
  const { state } = useWranglr();
  return <div data-status={state.connectionStatus}>{LABELS[state.connectionStatus]}</div>;
}
```

Update `pwa/app/layout.tsx` to wrap children in `WranglrProvider` and render the badge. It needs the pairing info to build the WS URL, and pairing only exists client-side (`localStorage`), so this becomes a client component:

```tsx
"use client";

import type { ReactNode } from "react";
import { WranglrProvider } from "../lib/store";
import { ConnectionBadge } from "../components/ConnectionBadge";
import { loadPairing, wsUrl } from "../lib/pairing";

export default function RootLayout({ children }: { children: ReactNode }) {
  const pairing = loadPairing();

  return (
    <html lang="en">
      <body>
        {pairing ? (
          <WranglrProvider url={wsUrl(pairing)}>
            <ConnectionBadge />
            {children}
          </WranglrProvider>
        ) : (
          children
        )}
      </body>
    </html>
  );
}
```

Since `layout.tsx` is now a client component, move the `metadata` export (Next.js requires `metadata` exports to live in a server component) into a new `pwa/app/head.tsx`... actually Next's App Router doesn't support a separate `head.tsx` for metadata alongside a client root layout in the same way older versions did. Simplest fix: drop the `metadata` export from `layout.tsx` entirely and instead add the manifest link and title directly in the JSX:

```tsx
      <head>
        <title>Wranglr</title>
        <link rel="manifest" href="/manifest.json" />
      </head>
```

placed as a sibling of `<body>` inside `<html>`, before `<body>`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pwa && bun test components/ConnectionBadge.test.tsx`
Expected: PASS (3 tests)

Then run the full PWA suite to confirm the `store.tsx` export change and `layout.tsx` rewrite didn't break Task 8's smoke test:

Run: `cd pwa && bun test`
Expected: PASS, all suites

- [ ] **Step 5: Commit**

```bash
git add pwa/lib/store.tsx pwa/app/layout.tsx pwa/components/ConnectionBadge.tsx pwa/components/ConnectionBadge.test.tsx
git commit -m "feat(pwa): wire root layout to WranglrProvider with a connection status badge"
```

---

## Task 15: Dashboard screen

**Files:**
- Create: `pwa/app/dashboard/page.tsx`
- Test: `pwa/app/dashboard/page.test.tsx`

**Interfaces:**
- Consumes: `useWranglr`, `WranglrContext` (Task 10/14), `loadPairing` (Task 11).
- Produces: route `/dashboard`, listing worktrees with a link to `/worktree/[id]` (Task 16 renders that route; the `id` here is `encodeURIComponent(worktree.path)`).

- [ ] **Step 1: Write the failing test**

```tsx
/// <reference lib="dom" />
import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import DashboardPage from "./page";
import { WranglrContext, type WranglrState } from "../../lib/store";

function renderWithState(state: WranglrState) {
  render(
    <WranglrContext.Provider value={{ state, send: () => {} }}>
      <DashboardPage />
    </WranglrContext.Provider>,
  );
}

describe("DashboardPage", () => {
  test("lists each worktree with its path and state", () => {
    renderWithState({
      connectionStatus: "open",
      worktrees: [
        { path: "/repo/feature-x", herdrPaneId: "p1", state: "working" },
        { path: "/repo/feature-y", herdrPaneId: null, state: "idle" },
      ],
      hookEvents: [],
      pendingApprovals: [],
    });

    expect(screen.getByText("/repo/feature-x")).toBeTruthy();
    expect(screen.getByText("working")).toBeTruthy();
    expect(screen.getByText("/repo/feature-y")).toBeTruthy();
    expect(screen.getByText("idle")).toBeTruthy();
  });

  test("links each worktree to its detail page keyed by encoded path", () => {
    renderWithState({
      connectionStatus: "open",
      worktrees: [{ path: "/repo/feature-x", herdrPaneId: "p1", state: "working" }],
      hookEvents: [],
      pendingApprovals: [],
    });

    const link = screen.getByRole("link", { name: /feature-x/ });
    expect(link.getAttribute("href")).toBe(`/worktree/${encodeURIComponent("/repo/feature-x")}`);
  });

  test("shows a pending-approval count badge when approvals are waiting", () => {
    renderWithState({
      connectionStatus: "open",
      worktrees: [{ path: "/repo/feature-x", herdrPaneId: "p1", state: "blocked" }],
      hookEvents: [],
      pendingApprovals: [{ id: "1", worktreePath: "/repo/feature-x", tool: "Bash", input: {}, risk: "high" }],
    });

    expect(screen.getByText("1 pending")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pwa && bun test app/dashboard/page.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```tsx
"use client";

import { useWranglr } from "../../lib/store";

export default function DashboardPage() {
  const { state } = useWranglr();

  return (
    <main>
      <h1>Worktrees</h1>
      <ul>
        {state.worktrees.map((worktree) => {
          const pendingCount = state.pendingApprovals.filter((a) => a.worktreePath === worktree.path).length;
          return (
            <li key={worktree.path}>
              <a href={`/worktree/${encodeURIComponent(worktree.path)}`}>{worktree.path}</a>
              <span> {worktree.state}</span>
              {pendingCount > 0 && <span> {pendingCount} pending</span>}
            </li>
          );
        })}
      </ul>
    </main>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pwa && bun test app/dashboard/page.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add pwa/app/dashboard/page.tsx pwa/app/dashboard/page.test.tsx
git commit -m "feat(pwa): add dashboard screen listing worktrees and pending approvals"
```

---

## Task 16: Worktree detail screen — hook feed, approvals, prompt

**Files:**
- Create: `pwa/app/worktree/[id]/page.tsx`
- Test: `pwa/app/worktree/[id]/page.test.tsx`

**Interfaces:**
- Consumes: `useWranglr`, `WranglrContext` (Task 10/14).
- Produces: route `/worktree/[id]`, the terminal screen of the plan — nothing later depends on it.

Next.js App Router passes dynamic segments as a `params` prop (a `Promise<{ id: string }>` in current Next.js versions using the async-params convention) to the page component. To keep this component's core logic unit-testable without wrestling with that async-params plumbing in `happy-dom`, split it: an exported, directly-testable `WorktreeDetail({ worktreePath }: { worktreePath: string })` component holds all real logic, and the default-exported page does nothing but `await params` and decode `id` before rendering it.

- [ ] **Step 1: Write the failing test**

```tsx
/// <reference lib="dom" />
import { describe, expect, test } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { WorktreeDetail } from "./page";
import { WranglrContext, type WranglrState } from "../../../lib/store";

function renderWithState(state: WranglrState, send = (_msg: unknown) => {}) {
  render(
    <WranglrContext.Provider value={{ state, send: send as never }}>
      <WorktreeDetail worktreePath="/repo/feature-x" />
    </WranglrContext.Provider>,
  );
}

describe("WorktreeDetail", () => {
  test("renders hook events scoped to this worktree only", () => {
    renderWithState({
      connectionStatus: "open",
      worktrees: [],
      hookEvents: [
        { type: "hook_event", hook: "PreToolUse", worktreePath: "/repo/feature-x", tool: "Read", input: {}, output: null },
        { type: "hook_event", hook: "PreToolUse", worktreePath: "/repo/other", tool: "Bash", input: {}, output: null },
      ],
      pendingApprovals: [],
    });

    expect(screen.getByText("Read")).toBeTruthy();
    expect(screen.queryByText("Bash")).toBeNull();
  });

  test("renders a pending approval for this worktree with approve/reject buttons", () => {
    renderWithState({
      connectionStatus: "open",
      worktrees: [],
      hookEvents: [],
      pendingApprovals: [{ id: "1", worktreePath: "/repo/feature-x", tool: "Bash", input: { command: "rm -rf /" }, risk: "high" }],
    });

    expect(screen.getByText("Bash")).toBeTruthy();
    expect(screen.getByText("high")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
  });

  test("clicking Approve sends an approval_response with decision approve and the request id", () => {
    const sent: unknown[] = [];
    renderWithState(
      {
        connectionStatus: "open",
        worktrees: [],
        hookEvents: [],
        pendingApprovals: [{ id: "req-1", worktreePath: "/repo/feature-x", tool: "Bash", input: {}, risk: "high" }],
      },
      (msg) => sent.push(msg),
    );

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(sent).toEqual([{ type: "approval_response", id: "req-1", decision: "approve" }]);
  });

  test("clicking Reject sends an approval_response with decision reject", () => {
    const sent: unknown[] = [];
    renderWithState(
      {
        connectionStatus: "open",
        worktrees: [],
        hookEvents: [],
        pendingApprovals: [{ id: "req-1", worktreePath: "/repo/feature-x", tool: "Bash", input: {}, risk: "high" }],
      },
      (msg) => sent.push(msg),
    );

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(sent).toEqual([{ type: "approval_response", id: "req-1", decision: "reject" }]);
  });

  test("submitting the prompt form sends a prompt ClientMessage for this worktree", () => {
    const sent: unknown[] = [];
    renderWithState(
      { connectionStatus: "open", worktrees: [], hookEvents: [], pendingApprovals: [] },
      (msg) => sent.push(msg),
    );

    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "run the tests" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(sent).toEqual([{ type: "prompt", worktreePath: "/repo/feature-x", text: "run the tests" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pwa && bun test app/worktree/\[id\]/page.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```tsx
"use client";

import { useState, type FormEvent } from "react";
import { useWranglr } from "../../../lib/store";

export function WorktreeDetail({ worktreePath }: { worktreePath: string }) {
  const { state, send } = useWranglr();
  const [prompt, setPrompt] = useState("");

  const events = state.hookEvents.filter((e) => e.worktreePath === worktreePath);
  const approvals = state.pendingApprovals.filter((a) => a.worktreePath === worktreePath);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    send({ type: "prompt", worktreePath, text: prompt });
    setPrompt("");
  }

  return (
    <main>
      <h1>{worktreePath}</h1>

      <section>
        <h2>Pending approvals</h2>
        {approvals.map((approval) => (
          <div key={approval.id}>
            <span>{approval.tool}</span>
            <span> {approval.risk}</span>
            <button onClick={() => send({ type: "approval_response", id: approval.id, decision: "approve" })}>
              Approve
            </button>
            <button onClick={() => send({ type: "approval_response", id: approval.id, decision: "reject" })}>
              Reject
            </button>
          </div>
        ))}
      </section>

      <section>
        <h2>Activity</h2>
        <ul>
          {events.map((event, i) => (
            <li key={i}>{event.tool}</li>
          ))}
        </ul>
      </section>

      <form onSubmit={handleSubmit}>
        <label htmlFor="prompt">Prompt</label>
        <input id="prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        <button type="submit">Send</button>
      </form>
    </main>
  );
}

export default async function WorktreePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <WorktreeDetail worktreePath={decodeURIComponent(id)} />;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pwa && bun test app/worktree/\[id\]/page.test.tsx`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add "pwa/app/worktree/[id]/page.tsx" "pwa/app/worktree/[id]/page.test.tsx"
git commit -m "feat(pwa): add worktree detail screen with approvals and prompt input"
```

---

## Task 17: Push notification registration

**Files:**
- Create: `pwa/lib/push.ts`
- Test: `pwa/lib/push.test.ts`
- Create: `pwa/public/sw.js`
- Modify: `pwa/app/dashboard/page.tsx` (add an enable-notifications button)

**Interfaces:**
- Consumes: `loadPairing` (Task 11).
- Produces: `registerPush(pairing: PairingInfo): Promise<"granted" | "denied" | "unsupported">`, called from the dashboard's new button — nothing later depends on this.

The full flow (service worker registration, `Notification.requestPermission()`, `PushManager.subscribe()`, actual browser push delivery) is not automatable under `happy-dom` — no real Push API, no real service worker container. The one pure, testable piece is the URL-safe base64 conversion needed to pass the VAPID public key into `applicationServerKey`. Everything else gets a manual verification step.

- [ ] **Step 1: Write the failing test**

```ts
/// <reference lib="dom" />
import { describe, expect, test } from "bun:test";
import { urlBase64ToUint8Array } from "./push";

describe("urlBase64ToUint8Array", () => {
  test("decodes a URL-safe base64 VAPID key into a Uint8Array", () => {
    // "SGVsbG8" (URL-safe, no padding) decodes to the ASCII bytes for "Hello"
    const result = urlBase64ToUint8Array("SGVsbG8");
    expect(Array.from(result)).toEqual([72, 101, 108, 108, 111]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pwa && bun test lib/push.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
import type { PairingInfo } from "./pairing";

export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from(rawData, (char) => char.charCodeAt(0));
}

export async function registerPush(pairing: PairingInfo): Promise<"granted" | "denied" | "unsupported"> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return "unsupported";
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "denied";

  const registration = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;

  const keyResponse = await fetch(`http://${pairing.hostname}:${pairing.port}/vapid-public-key?token=${pairing.token}`);
  const { publicKey } = (await keyResponse.json()) as { publicKey: string };

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });

  await fetch(`http://${pairing.hostname}:${pairing.port}/push-subscribe?token=${pairing.token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(subscription.toJSON()),
  });

  return "granted";
}
```

`pwa/public/sw.js` (plain JS — this is a static asset served as-is, not compiled by Next.js):

```js
self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : { title: "Wranglr", body: "" };
  event.waitUntil(self.registration.showNotification(data.title, { body: data.body }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => {
      if (clients.length > 0) {
        return clients[0].focus();
      }
      return self.clients.openWindow("/dashboard");
    }),
  );
});
```

Add the enable-notifications button to `pwa/app/dashboard/page.tsx` (append inside the existing `<main>`, after the `<ul>`):

```tsx
      <button
        onClick={() => {
          const pairing = loadPairing();
          if (pairing) void registerPush(pairing);
        }}
      >
        Enable notifications
      </button>
```

with the corresponding imports added at the top of that file:

```tsx
import { loadPairing } from "../../lib/pairing";
import { registerPush } from "../../lib/push";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pwa && bun test lib/push.test.ts`
Expected: PASS (1 test)

Then run the full suite once more to confirm the dashboard edit didn't break Task 15's tests:

Run: `cd pwa && bun test`
Expected: PASS, all suites

- [ ] **Step 5: Manual verification**

On a real device/browser (push requires a secure context — `localhost` counts):

1. Pair with a running daemon (Task 6/12/13).
2. Open `/dashboard`, click "Enable notifications", grant the permission prompt.
3. Confirm `GET /vapid-public-key` and `POST /push-subscribe` both succeed (check the browser's network tab).
4. From the daemon side, trigger a policy `"ask"` decision (see Task 4's manual test) and confirm a real OS push notification arrives even with the PWA tab closed.
5. Tap the notification, confirm it opens/focuses the PWA at `/dashboard`.

- [ ] **Step 6: Commit**

```bash
git add pwa/lib/push.ts pwa/lib/push.test.ts pwa/public/sw.js pwa/app/dashboard/page.tsx
git commit -m "feat(pwa): add push notification registration and service worker"
```

---

## Task 18: Redirect-to-pairing on first load

**Files:**
- Modify: `pwa/app/page.tsx`
- Test: `pwa/app/page.test.tsx`

**Interfaces:**
- Consumes: `loadPairing` (Task 11).
- Produces: final behavior of the root route — nothing later depends on it. This is the plan's last task.

- [ ] **Step 1: Update the failing test**

Replace `pwa/app/page.test.tsx` (from Task 8) in full:

```tsx
/// <reference lib="dom" />
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { render } from "@testing-library/react";
import Home from "./page";
import { savePairing, clearPairing } from "../lib/pairing";

const originalLocation = window.location;

beforeEach(() => {
  clearPairing();
  // @ts-expect-error -- overriding for the test, restored in afterEach
  delete window.location;
  // @ts-expect-error -- assigning a minimal stub
  window.location = { href: "" };
});

afterEach(() => {
  window.location = originalLocation;
});

describe("Home", () => {
  test("redirects to /pair when no pairing is saved", () => {
    render(<Home />);
    expect(window.location.href).toBe("/pair");
  });

  test("redirects to /dashboard when a pairing is already saved", () => {
    savePairing({ hostname: "100.64.1.2", port: 7420, token: "tok" });
    render(<Home />);
    expect(window.location.href).toBe("/dashboard");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pwa && bun test app/page.test.tsx`
Expected: FAIL — current `Home` renders `<main>Wranglr</main>` and never touches `window.location`

- [ ] **Step 3: Write the implementation**

Replace `pwa/app/page.tsx` in full:

```tsx
"use client";

import { useEffect } from "react";
import { loadPairing } from "../lib/pairing";

export default function Home() {
  useEffect(() => {
    window.location.href = loadPairing() ? "/dashboard" : "/pair";
  }, []);

  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pwa && bun test app/page.test.tsx`
Expected: PASS (2 tests)

Then run the complete PWA and daemon suites once more end to end:

Run: `bun test` (from the repo root, runs both workspaces)
Expected: PASS, every suite in both `daemon/` and `pwa/`

- [ ] **Step 5: Commit**

```bash
git add pwa/app/page.tsx pwa/app/page.test.tsx
git commit -m "feat(pwa): redirect root route to /pair or /dashboard based on stored pairing"
```
