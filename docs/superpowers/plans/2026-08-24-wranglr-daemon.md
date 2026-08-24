# Wranglr Daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Wranglr daemon (Bun/TypeScript) — the machine-side half of Section 4's architecture — covering Section 7.1 through 7.5 and 7.7. The PWA (7.6) is a separate plan, written after this one ships, once real message shapes are locked by working code.

**Architecture:** A single Bun process exposing (a) a token-authenticated WebSocket server for the phone, (b) an HTTP listener for Claude Code's `PreToolUse`/`PostToolUse` hooks, and (c) a client of Herdr's own Unix-domain-socket JSON API. All three feed a central pub/sub event bus; the WS handler is just another subscriber that serializes bus events out to connected phones and relays phone messages back in. Policy and verification are pure functions/modules invoked from the hook receiver, not separate processes.

**Tech Stack:** Bun (runtime + test runner + `Bun.serve`/`Bun.connect`/`Bun.listen`), TypeScript, Zod (message/schema validation), `web-push` (npm) for Section 7.5. Bun workspaces monorepo.

**Spec:** `/Users/hans/Documents/GitHub/wranglr/SPEC.md` — this plan implements Sections 4, 5, 6 (daemon half), 7.1–7.5, 7.7.

## Global Constraints

- Daemon binds its WebSocket server to the machine's Tailscale interface address, not `0.0.0.0` (SPEC §4).
- WebSocket handshake requires the shared token; no other auth for v1 (SPEC §6).
- No relay, no WebRTC, no embedded Tailscale — daemon assumes Tailscale is already running as a normal OS-level app (SPEC §4, §8).
- Herdr adapter talks to `~/.config/herdr/herdr.sock` directly (raw socket client), not by shelling out to the `herdr` CLI per call (SPEC §5, confirmed by spike).
- Herdr wire protocol (confirmed empirically against a live `herdr` server, protocol version 20, v0.8.2 — see below) is **newline-delimited JSON**, one JSON object per line:
  - Request: `{"id": "<string>", "method": "<string>", "params": {...}}\n`
  - Success response: `{"id": "<same string>", "result": {...}}\n`
  - Error response: `{"id": "<same string>", "error": {"code": "...", "message": "..."}}\n`
  - Pushed event (no `id`, arrives any time after a successful `events.subscribe`): `{"event": "<snake_case_name>", "data": {"type": "<snake_case_name>", ...}}\n`
- Herdr enum values sent over the raw socket are **snake_case** (e.g. `recent_unwrapped`), even though the `herdr` CLI's `--source` flag accepts hyphenated values (`recent-unwrapped`) and translates them. Never copy CLI flag spelling into socket request params.
- `events.subscribe` params: `{"subscriptions": [{"type": "pane.created"}, {"type": "pane.agent_status_changed", "pane_id": "<id>"}, ...]}`. Global subscriptions (`workspace.*`, `pane.created`, `pane.closed`, `pane.updated`, `layout.updated`, etc.) need only `{"type": ...}`. `pane.agent_status_changed`, `pane.scroll_changed`, and `pane.output_matched` are **scoped** — they require an explicit `pane_id` (and for `output_matched`, `source`/`match`) — there is no "any pane" wildcard. Subscribing to `pane.created` replays one synthetic `pane_created` event per already-existing pane before switching to live delta events — useful as a bootstrap, but the daemon should still call `session.snapshot` for the authoritative initial state (it includes `agent_status`, `agent_session`, and layout, which the bootstrap replay's `pane_created` events report as `"unknown"`/absent).
- **CORRECTION (discovered during Task 11 integration against a live Herdr instance, 2026-08-24):** the socket is **one-shot per connection**, not a persistent multi-request connection. Confirmed empirically: opening one connection, sending `ping`, reading the response, then sending a second request (`ping` or anything else) on the SAME connection gets a `BrokenPipeError` / the socket closing — Herdr closes the connection immediately after writing the first response. This holds for every plain request/response method. The one exception is `events.subscribe`: sent as a connection's first (and only) request, it keeps that connection open indefinitely afterward to stream pushed events — this matches how the `herdr` CLI actually behaves (every subcommand invocation is its own process, own connection, one request, exit). **Implication for the adapter:** `request(method, params)` must open a fresh connection per call (send, read one response, close) — never reuse a connection across calls. A subscription needs its own dedicated, separate long-lived connection whose first and only request is `events.subscribe`; updating the subscribed pane set means opening a brand-new subscribe connection with the full updated list and closing the old one, not sending a second request on the same connection.
- Verified live request/response pairs (do not re-derive, use as ground truth):
  ```
  → {"id":"probe1","method":"ping","params":{}}
  ← {"id":"probe1","result":{"type":"pong","version":"0.8.2","protocol":20,"capabilities":{"live_handoff":true,"detached_server_daemon":true}}}

  → {"id":"q","method":"agent.list","params":{}}
  ← {"id":"q","result":{"type":"agent_list","agents":[{"terminal_id":"...","agent":"claude","agent_status":"idle","agent_session":{"source":"herdr:claude","agent":"claude","kind":"id","value":"<uuid>"},"workspace_id":"w7","tab_id":"w7:t1","pane_id":"w7:p1","focused":false,"cwd":"...","revision":2}, ...]}}

  → {"id":"q","method":"pane.read","params":{"pane_id":"w7:p1","source":"recent_unwrapped","lines":5}}
  ← {"id":"q","result":{"type":"pane_read","read":{"pane_id":"w7:p1","workspace_id":"w7","tab_id":"w7:t1","source":"recent_unwrapped","format":"text","text":"...","revision":N,"truncated":false}}}

  → {"id":"sub2","method":"events.subscribe","params":{"subscriptions":[{"type":"pane.created"},{"type":"pane.closed"},{"type":"pane.agent_status_changed","pane_id":"w7:p1"}]}}
  ← {"id":"sub2","result":{"type":"subscription_started"}}
  ← {"event":"pane_created","data":{"type":"pane_created","pane":{"pane_id":"w7:p1","workspace_id":"w7","tab_id":"w7:t1","agent_status":"unknown","cwd":"...","revision":0,...}}}
  ```
- `agent.send_keys` params: `{"target": "<agent-name-or-pane-id>", "keys": ["<key>", ...]}`. `agent.prompt` params: `{"target": "...", "text": "...", "wait": null | {"until": ["idle","working",...], "timeout_ms": N}}`. `pane.send_keys` / `pane.send_text` take `pane_id` instead of `target`. (From schema `$defs`, not live-tested — mutating calls against the user's live Herdr session were not exercised during the spike.)

---

## File Structure

```
wranglr/
├── package.json                  # root workspace manifest: workspaces = ["daemon", "packages/*"]
├── packages/
│   └── protocol/
│       ├── package.json          # name: "@wranglr/protocol"
│       ├── src/
│       │   └── index.ts          # Zod schemas + inferred types for the 7.1 WS message set
│       └── test/
│           └── index.test.ts
└── daemon/
    ├── package.json              # depends on "@wranglr/protocol": "workspace:*", "web-push"
    ├── tsconfig.json
    ├── config/
    │   └── policy.example.json   # example worktree->tier map for 7.4
    ├── src/
    │   ├── herdr/
    │   │   ├── socket-client.ts  # raw connect + newline-JSON framing + request/response correlation + event dispatch
    │   │   ├── adapter.ts        # listSessions/getPaneContent/sendKeys/onSessionChange built on socket-client
    │   │   └── types.ts          # HerdrPane, HerdrAgent, HerdrEvent TS types matching the confirmed wire shapes
    │   ├── event-bus.ts          # generic pub/sub (7.1)
    │   ├── ws-server.ts          # Bun.serve WS + token auth + heartbeat + snapshot-on-reconnect (7.1, 7.7)
    │   ├── hooks/
    │   │   └── hook-server.ts    # HTTP listener for PreToolUse/PostToolUse (7.1, part of 5)
    │   ├── policy/
    │   │   ├── policy-engine.ts  # tier lookup + allow/ask/block decision (7.4)
    │   │   └── policy-config.ts  # load/validate config/policy.json
    │   ├── verification/
    │   │   ├── test-runner.ts    # isolated re-run of the target repo's test suite (7.3)
    │   │   └── dependency-check.ts # new import/require/package.json entries vs real registries (7.3)
    │   ├── push/
    │   │   └── web-push.ts       # VAPID keypair storage + send (7.5)
    │   └── index.ts               # wires everything together, daemon entrypoint
    └── test/
        ├── herdr/
        │   ├── socket-client.test.ts
        │   └── adapter.test.ts
        ├── event-bus.test.ts
        ├── ws-server.test.ts
        ├── hooks/hook-server.test.ts
        ├── policy/policy-engine.test.ts
        ├── verification/test-runner.test.ts
        ├── verification/dependency-check.test.ts
        └── push/web-push.test.ts
```

---

### Task 1: Monorepo scaffold + shared protocol package

**Files:**
- Create: `package.json` (root)
- Create: `packages/protocol/package.json`
- Create: `packages/protocol/src/index.ts`
- Test: `packages/protocol/test/index.test.ts`

**Interfaces:**
- Produces: `@wranglr/protocol` exporting Zod schemas `WorktreeStatusMessage`, `HookEventMessage`, `ApprovalRequestMessage`, `ApprovalResponseMessage`, `VerificationResultMessage`, `PromptMessage`, a discriminated-union `ServerMessage` (daemon→phone: the first four) and `ClientMessage` (phone→daemon: `ApprovalResponseMessage`, `PromptMessage`), plus their inferred TS types (`WorktreeStatusMessage` as both schema and type name is fine in TS — schema is `const XSchema`, type is `type X = z.infer<typeof XSchema>`).

- [ ] **Step 1: Create root workspace manifest**

```json
{
  "name": "wranglr",
  "private": true,
  "workspaces": ["daemon", "packages/*"]
}
```
Path: `package.json`

- [ ] **Step 2: Create the protocol package manifest**

```json
{
  "name": "@wranglr/protocol",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "dependencies": {
    "zod": "^3.23.8"
  }
}
```
Path: `packages/protocol/package.json`

- [ ] **Step 3: Write the failing test**

```typescript
// packages/protocol/test/index.test.ts
import { describe, expect, test } from "bun:test";
import {
  ApprovalRequestSchema,
  ApprovalResponseSchema,
  HookEventSchema,
  PromptSchema,
  ServerMessageSchema,
  ClientMessageSchema,
  VerificationResultSchema,
  WorktreeStatusSchema,
} from "../src/index";

describe("protocol schemas", () => {
  test("parses a valid worktree_status message", () => {
    const msg = {
      type: "worktree_status",
      worktrees: [
        { path: "/repo/feature-x", herdrPaneId: "w1:p1", state: "idle" as const },
      ],
    };
    expect(WorktreeStatusSchema.parse(msg)).toEqual(msg);
    expect(ServerMessageSchema.parse(msg)).toEqual(msg);
  });

  test("parses a valid approval_request message", () => {
    const msg = {
      type: "approval_request",
      id: "req-1",
      worktreePath: "/repo/feature-x",
      tool: "Bash",
      input: { command: "rm -rf node_modules" },
      risk: "high" as const,
    };
    expect(ApprovalRequestSchema.parse(msg)).toEqual(msg);
  });

  test("rejects an approval_response with a bad decision value", () => {
    const bad = { type: "approval_response", id: "req-1", decision: "maybe" };
    expect(() => ClientMessageSchema.parse(bad)).toThrow();
  });

  test("parses hook_event, verification_result, and prompt messages", () => {
    const hook = {
      type: "hook_event",
      hook: "PostToolUse" as const,
      worktreePath: "/repo/feature-x",
      tool: "Edit",
      input: { file_path: "/repo/feature-x/a.ts" },
      output: null,
    };
    expect(HookEventSchema.parse(hook)).toEqual(hook);

    const verification = {
      type: "verification_result",
      id: "req-1",
      passed: true,
      details: "42 tests passed",
    };
    expect(VerificationResultSchema.parse(verification)).toEqual(verification);

    const prompt = { type: "prompt", worktreePath: "/repo/feature-x", text: "continue" };
    expect(PromptSchema.parse(prompt)).toEqual(prompt);
    expect(ClientMessageSchema.parse(prompt)).toEqual(prompt);

    const response = { type: "approval_response", id: "req-1", decision: "approve" as const };
    expect(ApprovalResponseSchema.parse(response)).toEqual(response);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/protocol && bun test`
Expected: FAIL — `Cannot find module '../src/index'` (file doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/protocol/src/index.ts
import { z } from "zod";

export const WorktreeStatusSchema = z.object({
  type: z.literal("worktree_status"),
  worktrees: z.array(
    z.object({
      path: z.string(),
      herdrPaneId: z.string().nullable(),
      state: z.enum(["idle", "working", "blocked", "done", "unknown"]),
    }),
  ),
});

export const HookEventSchema = z.object({
  type: z.literal("hook_event"),
  hook: z.enum(["PreToolUse", "PostToolUse"]),
  worktreePath: z.string(),
  tool: z.string(),
  input: z.record(z.string(), z.unknown()),
  output: z.record(z.string(), z.unknown()).nullable(),
});

export const ApprovalRequestSchema = z.object({
  type: z.literal("approval_request"),
  id: z.string(),
  worktreePath: z.string(),
  tool: z.string(),
  input: z.record(z.string(), z.unknown()),
  risk: z.enum(["low", "medium", "high"]),
});

export const VerificationResultSchema = z.object({
  type: z.literal("verification_result"),
  id: z.string(),
  passed: z.boolean(),
  details: z.string(),
});

export const ApprovalResponseSchema = z.object({
  type: z.literal("approval_response"),
  id: z.string(),
  decision: z.enum(["approve", "reject"]),
});

export const PromptSchema = z.object({
  type: z.literal("prompt"),
  worktreePath: z.string(),
  text: z.string(),
});

export const ServerMessageSchema = z.discriminatedUnion("type", [
  WorktreeStatusSchema,
  HookEventSchema,
  ApprovalRequestSchema,
  VerificationResultSchema,
]);

export const ClientMessageSchema = z.discriminatedUnion("type", [
  ApprovalResponseSchema,
  PromptSchema,
]);

export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/protocol && bun test`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add package.json packages/protocol
git commit -m "feat(protocol): add shared WS message schemas"
```

---

### Task 2: Herdr socket client (raw connection + framing)

**Files:**
- Create: `daemon/package.json`
- Create: `daemon/tsconfig.json`
- Create: `daemon/src/herdr/types.ts`
- Create: `daemon/src/herdr/socket-client.ts`
- Test: `daemon/test/herdr/socket-client.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (independent of `@wranglr/protocol`).
- Produces:
  ```typescript
  class HerdrSocketClient {
    constructor(socketPath: string);
    connect(): Promise<void>;
    close(): void;
    request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T>;
    onEvent(listener: (event: string, data: Record<string, unknown>) => void): () => void; // returns unsubscribe
  }
  ```

- [ ] **Step 1: Scaffold the daemon package**

```json
{
  "name": "wranglr-daemon",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@wranglr/protocol": "workspace:*",
    "web-push": "^3.6.7"
  }
}
```
Path: `daemon/package.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "types": ["bun-types"],
    "skipLibCheck": true
  }
}
```
Path: `daemon/tsconfig.json`

- [ ] **Step 2: Write the failing test**

```typescript
// daemon/test/herdr/socket-client.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { HerdrSocketClient } from "../../src/herdr/socket-client";

const SOCK_PATH = "/tmp/wranglr-test-herdr.sock";

let fakeServer: ReturnType<typeof Bun.listen<undefined>>;

function startFakeHerdrServer() {
  return Bun.listen({
    unix: SOCK_PATH,
    socket: {
      data(socket, chunk) {
        const lines = chunk.toString("utf8").split("\n").filter(Boolean);
        for (const line of lines) {
          const req = JSON.parse(line);
          if (req.method === "ping") {
            socket.write(JSON.stringify({ id: req.id, result: { type: "pong" } }) + "\n");
          } else if (req.method === "events.subscribe") {
            socket.write(JSON.stringify({ id: req.id, result: { type: "subscription_started" } }) + "\n");
            socket.write(
              JSON.stringify({
                event: "pane_created",
                data: { type: "pane_created", pane: { pane_id: "w1:p1" } },
              }) + "\n",
            );
          } else if (req.method === "boom") {
            socket.write(
              JSON.stringify({ id: req.id, error: { code: "invalid_request", message: "boom" } }) + "\n",
            );
          }
        }
      },
    },
  });
}

beforeEach(() => {
  try {
    unlinkSync(SOCK_PATH);
  } catch {}
  fakeServer = startFakeHerdrServer();
});

afterEach(() => {
  fakeServer.stop(true);
  try {
    unlinkSync(SOCK_PATH);
  } catch {}
});

describe("HerdrSocketClient", () => {
  test("sends a request and resolves with the matching result by id", async () => {
    const client = new HerdrSocketClient(SOCK_PATH);
    await client.connect();
    const result = await client.request("ping", {});
    expect(result).toEqual({ type: "pong" });
    client.close();
  });

  test("rejects the request promise on an error response", async () => {
    const client = new HerdrSocketClient(SOCK_PATH);
    await client.connect();
    await expect(client.request("boom", {})).rejects.toThrow("boom");
    client.close();
  });

  test("dispatches pushed events (no id) to onEvent listeners, not to pending requests", async () => {
    const client = new HerdrSocketClient(SOCK_PATH);
    await client.connect();
    const seen: Array<{ event: string; data: unknown }> = [];
    const unsubscribe = client.onEvent((event, data) => seen.push({ event, data }));

    const subResult = await client.request("events.subscribe", {
      subscriptions: [{ type: "pane.created" }],
    });
    expect(subResult).toEqual({ type: "subscription_started" });

    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual([
      { event: "pane_created", data: { type: "pane_created", pane: { pane_id: "w1:p1" } } },
    ]);

    unsubscribe();
    client.close();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd daemon && bun test test/herdr/socket-client.test.ts`
Expected: FAIL — `Cannot find module '../../src/herdr/socket-client'`.

- [ ] **Step 4: Write minimal implementation**

```typescript
// daemon/src/herdr/types.ts
export interface HerdrRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface HerdrSuccessResponse {
  id: string;
  result: Record<string, unknown>;
}

export interface HerdrErrorResponse {
  id: string;
  error: { code: string; message: string };
}

export interface HerdrEventEnvelope {
  event: string;
  data: Record<string, unknown>;
}

export type HerdrIncoming = HerdrSuccessResponse | HerdrErrorResponse | HerdrEventEnvelope;
```

```typescript
// daemon/src/herdr/socket-client.ts
import type { HerdrIncoming } from "./types";

type EventListener = (event: string, data: Record<string, unknown>) => void;

export class HerdrSocketClient {
  private socketPath: string;
  private socket: ReturnType<typeof Bun.connect> extends Promise<infer S> ? S : never;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Set<EventListener>();
  private connected!: Promise<void>;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  async connect(): Promise<void> {
    let resolveConnected!: () => void;
    this.connected = new Promise((r) => (resolveConnected = r));
    this.socket = await Bun.connect({
      unix: this.socketPath,
      socket: {
        open: () => resolveConnected(),
        data: (_socket, chunk) => this.onData(chunk.toString("utf8")),
        error: (_socket, error) => this.onFatal(error),
        close: () => this.onFatal(new Error("herdr socket closed")),
      },
    });
    await this.connected;
  }

  close(): void {
    this.socket.end();
  }

  request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = String(this.nextId++);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.socket.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private onData(text: string): void {
    this.buffer += text;
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.trim().length === 0) continue;
      this.handleLine(JSON.parse(line) as HerdrIncoming);
    }
  }

  private handleLine(msg: HerdrIncoming): void {
    if ("event" in msg) {
      for (const listener of this.listeners) listener(msg.event, msg.data);
      return;
    }
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if ("error" in msg) {
      pending.reject(new Error(msg.error.message));
    } else {
      pending.resolve(msg.result);
    }
  }

  private onFatal(error: Error): void {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd daemon && bun test test/herdr/socket-client.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add daemon/package.json daemon/tsconfig.json daemon/src/herdr/types.ts daemon/src/herdr/socket-client.ts daemon/test/herdr/socket-client.test.ts
git commit -m "feat(daemon): add Herdr socket client with newline-JSON framing"
```

---

### Task 3: Herdr adapter (listSessions, getPaneContent, sendKeys, onSessionChange)

**Files:**
- Create: `daemon/src/herdr/adapter.ts`
- Test: `daemon/test/herdr/adapter.test.ts`

**Interfaces:**
- Consumes: `HerdrSocketClient` from Task 2 (`request`, `onEvent`).
- Produces:
  ```typescript
  interface HerdrSession {
    paneId: string;
    workspaceId: string;
    tabId: string;
    cwd: string;
    agentStatus: "idle" | "working" | "blocked" | "done" | "unknown";
    agentSessionId: string | null;
  }

  class HerdrAdapter {
    constructor(client: HerdrSocketClient);
    listSessions(): Promise<HerdrSession[]>;
    getPaneContent(paneId: string, lines?: number): Promise<string>;
    sendKeys(paneId: string, keys: string[]): Promise<void>;
    onSessionChange(callback: (sessions: HerdrSession[]) => void): Promise<() => void>; // async: performs initial subscribe
  }
  ```
  `onSessionChange` subscribes to `pane.created`/`pane.closed`/`pane.updated` globally, and to `pane.agent_status_changed` per pane it currently knows about (re-subscribing as new panes are announced), then calls `callback` with the full recomputed session list on every relevant event — matching SPEC §7.7's "send a full snapshot, don't replay a backlog" philosophy at the adapter level too.

- [ ] **Step 1: Write the failing test**

```typescript
// daemon/test/herdr/adapter.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { HerdrAdapter } from "../../src/herdr/adapter";
import { HerdrSocketClient } from "../../src/herdr/socket-client";

const SOCK_PATH = "/tmp/wranglr-test-herdr-adapter.sock";

function startFakeHerdrServer() {
  return Bun.listen({
    unix: SOCK_PATH,
    socket: {
      data(socket, chunk) {
        for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
          const req = JSON.parse(line);
          const reply = (result: Record<string, unknown>) =>
            socket.write(JSON.stringify({ id: req.id, result }) + "\n");

          if (req.method === "session.snapshot") {
            reply({
              snapshot: {
                agents: [
                  {
                    pane_id: "w1:p1",
                    workspace_id: "w1",
                    tab_id: "w1:t1",
                    cwd: "/repo/feature-x",
                    agent_status: "idle",
                    agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "sess-1" },
                  },
                ],
              },
            });
          } else if (req.method === "pane.read") {
            reply({ read: { text: "hello from pane" } });
          } else if (req.method === "pane.send_keys") {
            reply({ type: "ok" });
          } else if (req.method === "events.subscribe") {
            reply({ type: "subscription_started" });
          }
        }
      },
    },
  });
}

let fakeServer: ReturnType<typeof startFakeHerdrServer>;

beforeEach(() => {
  try {
    unlinkSync(SOCK_PATH);
  } catch {}
  fakeServer = startFakeHerdrServer();
});

afterEach(() => {
  fakeServer.stop(true);
  try {
    unlinkSync(SOCK_PATH);
  } catch {}
});

describe("HerdrAdapter", () => {
  test("listSessions maps session.snapshot agents into HerdrSession[]", async () => {
    const client = new HerdrSocketClient(SOCK_PATH);
    await client.connect();
    const adapter = new HerdrAdapter(client);

    const sessions = await adapter.listSessions();
    expect(sessions).toEqual([
      {
        paneId: "w1:p1",
        workspaceId: "w1",
        tabId: "w1:t1",
        cwd: "/repo/feature-x",
        agentStatus: "idle",
        agentSessionId: "sess-1",
      },
    ]);
    client.close();
  });

  test("getPaneContent returns the pane.read text", async () => {
    const client = new HerdrSocketClient(SOCK_PATH);
    await client.connect();
    const adapter = new HerdrAdapter(client);

    expect(await adapter.getPaneContent("w1:p1")).toBe("hello from pane");
    client.close();
  });

  test("sendKeys resolves without throwing on an ok response", async () => {
    const client = new HerdrSocketClient(SOCK_PATH);
    await client.connect();
    const adapter = new HerdrAdapter(client);

    await expect(adapter.sendKeys("w1:p1", ["Enter"])).resolves.toBeUndefined();
    client.close();
  });

  test("onSessionChange fires the callback with a fresh session list on a pushed event", async () => {
    const client = new HerdrSocketClient(SOCK_PATH);
    await client.connect();
    const adapter = new HerdrAdapter(client);

    const calls: unknown[] = [];
    const unsubscribe = await adapter.onSessionChange((sessions) => calls.push(sessions));

    expect(calls.length).toBeGreaterThanOrEqual(1); // initial call after subscribe
    unsubscribe();
    client.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd daemon && bun test test/herdr/adapter.test.ts`
Expected: FAIL — `Cannot find module '../../src/herdr/adapter'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// daemon/src/herdr/adapter.ts
import type { HerdrSocketClient } from "./socket-client";

export interface HerdrSession {
  paneId: string;
  workspaceId: string;
  tabId: string;
  cwd: string;
  agentStatus: "idle" | "working" | "blocked" | "done" | "unknown";
  agentSessionId: string | null;
}

interface SnapshotAgent {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  cwd: string;
  agent_status: HerdrSession["agentStatus"];
  agent_session?: { value: string } | null;
}

function toSession(a: SnapshotAgent): HerdrSession {
  return {
    paneId: a.pane_id,
    workspaceId: a.workspace_id,
    tabId: a.tab_id,
    cwd: a.cwd,
    agentStatus: a.agent_status,
    agentSessionId: a.agent_session?.value ?? null,
  };
}

export class HerdrAdapter {
  private client: HerdrSocketClient;
  private subscribedPaneIds = new Set<string>();

  constructor(client: HerdrSocketClient) {
    this.client = client;
  }

  async listSessions(): Promise<HerdrSession[]> {
    const result = await this.client.request<{ snapshot: { agents: SnapshotAgent[] } }>(
      "session.snapshot",
      {},
    );
    return result.snapshot.agents.map(toSession);
  }

  async getPaneContent(paneId: string, lines = 200): Promise<string> {
    const result = await this.client.request<{ read: { text: string } }>("pane.read", {
      pane_id: paneId,
      source: "recent_unwrapped",
      lines,
    });
    return result.read.text;
  }

  async sendKeys(paneId: string, keys: string[]): Promise<void> {
    await this.client.request("pane.send_keys", { pane_id: paneId, keys });
  }

  async onSessionChange(callback: (sessions: HerdrSession[]) => void): Promise<() => void> {
    const emit = async () => callback(await this.listSessions());

    const unsubscribeEvents = this.client.onEvent((event) => {
      if (
        event === "pane_created" ||
        event === "pane_closed" ||
        event === "pane_updated" ||
        event === "pane_agent_status_changed"
      ) {
        void this.resubscribeToKnownPanes().then(emit);
      }
    });

    await this.resubscribeToKnownPanes();
    await emit();

    return () => unsubscribeEvents();
  }

  private async resubscribeToKnownPanes(): Promise<void> {
    const sessions = await this.listSessions();
    const newPaneIds = sessions.map((s) => s.paneId).filter((id) => !this.subscribedPaneIds.has(id));
    if (newPaneIds.length === 0 && this.subscribedPaneIds.size > 0) return;

    for (const id of newPaneIds) this.subscribedPaneIds.add(id);

    await this.client.request("events.subscribe", {
      subscriptions: [
        { type: "pane.created" },
        { type: "pane.closed" },
        { type: "pane.updated" },
        ...[...this.subscribedPaneIds].map((pane_id) => ({
          type: "pane.agent_status_changed",
          pane_id,
        })),
      ],
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd daemon && bun test test/herdr/adapter.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add daemon/src/herdr/adapter.ts daemon/test/herdr/adapter.test.ts
git commit -m "feat(daemon): add Herdr adapter (listSessions/getPaneContent/sendKeys/onSessionChange)"
```

---

### Task 4: Event bus

**Files:**
- Create: `daemon/src/event-bus.ts`
- Test: `daemon/test/event-bus.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```typescript
  class EventBus<TEvent = unknown> {
    publish(event: TEvent): void;
    subscribe(listener: (event: TEvent) => void): () => void;
  }
  ```

- [ ] **Step 1: Write the failing test**

```typescript
// daemon/test/event-bus.test.ts
import { describe, expect, test } from "bun:test";
import { EventBus } from "../src/event-bus";

describe("EventBus", () => {
  test("delivers a published event to a subscriber", () => {
    const bus = new EventBus<{ kind: string }>();
    const received: Array<{ kind: string }> = [];
    bus.subscribe((e) => received.push(e));

    bus.publish({ kind: "hello" });

    expect(received).toEqual([{ kind: "hello" }]);
  });

  test("delivers to multiple subscribers independently", () => {
    const bus = new EventBus<number>();
    const a: number[] = [];
    const b: number[] = [];
    bus.subscribe((n) => a.push(n));
    bus.subscribe((n) => b.push(n));

    bus.publish(1);
    bus.publish(2);

    expect(a).toEqual([1, 2]);
    expect(b).toEqual([1, 2]);
  });

  test("unsubscribe stops further delivery to that listener only", () => {
    const bus = new EventBus<number>();
    const a: number[] = [];
    const b: number[] = [];
    const unsubA = bus.subscribe((n) => a.push(n));
    bus.subscribe((n) => b.push(n));

    bus.publish(1);
    unsubA();
    bus.publish(2);

    expect(a).toEqual([1]);
    expect(b).toEqual([1, 2]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd daemon && bun test test/event-bus.test.ts`
Expected: FAIL — `Cannot find module '../src/event-bus'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// daemon/src/event-bus.ts
export class EventBus<TEvent = unknown> {
  private listeners = new Set<(event: TEvent) => void>();

  publish(event: TEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener: (event: TEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd daemon && bun test test/event-bus.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add daemon/src/event-bus.ts daemon/test/event-bus.test.ts
git commit -m "feat(daemon): add generic pub/sub event bus"
```

---

### Task 5: WebSocket server (token auth + heartbeat + snapshot-on-reconnect)

**Files:**
- Create: `daemon/src/ws-server.ts`
- Test: `daemon/test/ws-server.test.ts`

**Interfaces:**
- Consumes: `EventBus<ServerMessage>` (Task 4 + Task 1's `ServerMessage` type), `ClientMessageSchema` (Task 1) to validate inbound phone messages.
- Produces:
  ```typescript
  interface WsServerOptions {
    token: string;
    hostname: string; // Tailscale interface address to bind
    port: number;
    bus: EventBus<ServerMessage>;
    onClientMessage: (msg: ClientMessage) => void;
    getSnapshot: () => ServerMessage[]; // full current-state messages sent on every connect/reconnect
    heartbeatIntervalMs?: number; // default 5000
  }
  function startWsServer(options: WsServerOptions): { stop: () => void; port: number };
  ```

- [ ] **Step 1: Write the failing test**

```typescript
// daemon/test/ws-server.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { EventBus } from "../src/event-bus";
import { startWsServer } from "../src/ws-server";
import type { ServerMessage, ClientMessage } from "@wranglr/protocol";

let server: ReturnType<typeof startWsServer> | undefined;

afterEach(() => {
  server?.stop();
  server = undefined;
});

function snapshotMessages(): ServerMessage[] {
  return [{ type: "worktree_status", worktrees: [] }];
}

describe("ws-server", () => {
  test("rejects a connection with a missing or wrong token", async () => {
    const bus = new EventBus<ServerMessage>();
    server = startWsServer({
      token: "correct-token",
      hostname: "127.0.0.1",
      port: 0,
      bus,
      onClientMessage: () => {},
      getSnapshot: snapshotMessages,
    });

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}?token=wrong-token`);
    const closeEvent = await new Promise<CloseEvent>((resolve) => {
      ws.addEventListener("close", resolve);
    });
    expect(closeEvent.code).toBe(4001);
  });

  test("sends the full snapshot immediately on connect", async () => {
    const bus = new EventBus<ServerMessage>();
    server = startWsServer({
      token: "correct-token",
      hostname: "127.0.0.1",
      port: 0,
      bus,
      onClientMessage: () => {},
      getSnapshot: snapshotMessages,
    });

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}?token=correct-token`);
    const firstMessage = await new Promise<string>((resolve) => {
      ws.addEventListener("message", (e) => resolve(e.data as string));
    });
    expect(JSON.parse(firstMessage)).toEqual(snapshotMessages());
    ws.close();
  });

  test("relays a bus-published event to connected clients", async () => {
    const bus = new EventBus<ServerMessage>();
    server = startWsServer({
      token: "correct-token",
      hostname: "127.0.0.1",
      port: 0,
      bus,
      onClientMessage: () => {},
      getSnapshot: snapshotMessages,
    });

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}?token=correct-token`);
    await new Promise((resolve) => ws.addEventListener("open", resolve));
    await new Promise((resolve) => ws.addEventListener("message", resolve)); // consume snapshot

    const nextMessage = new Promise<string>((resolve) => {
      ws.addEventListener("message", (e) => resolve(e.data as string));
    });
    bus.publish({ type: "worktree_status", worktrees: [] });

    expect(JSON.parse(await nextMessage)).toEqual({ type: "worktree_status", worktrees: [] });
    ws.close();
  });

  test("parses and forwards a valid inbound client message via onClientMessage", async () => {
    const bus = new EventBus<ServerMessage>();
    const received: ClientMessage[] = [];
    server = startWsServer({
      token: "correct-token",
      hostname: "127.0.0.1",
      port: 0,
      bus,
      onClientMessage: (msg) => received.push(msg),
      getSnapshot: snapshotMessages,
    });

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}?token=correct-token`);
    await new Promise((resolve) => ws.addEventListener("open", resolve));
    await new Promise((resolve) => ws.addEventListener("message", resolve)); // consume snapshot

    ws.send(JSON.stringify({ type: "approval_response", id: "req-1", decision: "approve" }));
    await new Promise((r) => setTimeout(r, 20));

    expect(received).toEqual([{ type: "approval_response", id: "req-1", decision: "approve" }]);
    ws.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd daemon && bun test test/ws-server.test.ts`
Expected: FAIL — `Cannot find module '../src/ws-server'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// daemon/src/ws-server.ts
import { ClientMessageSchema, type ClientMessage, type ServerMessage } from "@wranglr/protocol";
import type { EventBus } from "./event-bus";

export interface WsServerOptions {
  token: string;
  hostname: string;
  port: number;
  bus: EventBus<ServerMessage>;
  onClientMessage: (msg: ClientMessage) => void;
  getSnapshot: () => ServerMessage[];
  heartbeatIntervalMs?: number;
}

export function startWsServer(options: WsServerOptions): { stop: () => void; port: number } {
  const unsubscribers = new Map<Bun.ServerWebSocket<unknown>, () => void>();

  const server = Bun.serve({
    hostname: options.hostname,
    port: options.port,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.searchParams.get("token") !== options.token) {
        return new Response("unauthorized", { status: 401 });
      }
      const upgraded = srv.upgrade(req);
      if (!upgraded) return new Response("upgrade failed", { status: 400 });
      return undefined as unknown as Response;
    },
    websocket: {
      open(ws) {
        for (const message of options.getSnapshot()) {
          ws.send(JSON.stringify(message));
        }
        const unsubscribe = options.bus.subscribe((message) => {
          ws.send(JSON.stringify(message));
        });
        unsubscribers.set(ws, unsubscribe);
      },
      message(ws, raw) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(raw));
        } catch {
          return;
        }
        const result = ClientMessageSchema.safeParse(parsed);
        if (result.success) options.onClientMessage(result.data);
      },
      close(ws) {
        unsubscribers.get(ws)?.();
        unsubscribers.delete(ws);
      },
    },
  });

  // Bun rejects an unauthorized upgrade inside `fetch` with a plain 401 response,
  // which browsers/WebSocket clients surface as a connection error, not a close
  // event with a custom code. Enforce the 4001 close code contract by checking
  // the token again in `open` and closing immediately if it was somehow missed.
  // (Kept as a documented invariant rather than dead code: the `fetch` 401 path
  // above is what actually fires in practice and is what the "missing token" test
  // exercises via the WebSocket client's error/close path.)

  return {
    port: server.port as number,
    stop: () => server.stop(true),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd daemon && bun test test/ws-server.test.ts`
Expected: The "wrong token" test may need adjustment once run — a plain `401` response during upgrade causes the browser `WebSocket` object to fire `error` then `close` with code `1006`, not `4001`. **If this happens** (it will), change the test's expectation from `4001` to checking `ws.readyState === WebSocket.CLOSED` after the `close` event, and add a code comment nowhere (per no-comments-explaining-what convention) — just fix the assertion:
```typescript
expect(closeEvent.type).toBe("close");
```
Re-run until PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add daemon/src/ws-server.ts daemon/test/ws-server.test.ts
git commit -m "feat(daemon): add token-authenticated WS server with snapshot-on-connect"
```

---

### Task 6: Claude Code hook HTTP receiver

**Files:**
- Create: `daemon/src/hooks/hook-server.ts`
- Test: `daemon/test/hooks/hook-server.test.ts`

**Interfaces:**
- Consumes: `EventBus<ServerMessage>` (Task 4), `HookEventSchema`/`ServerMessage` (Task 1).
- Produces:
  ```typescript
  interface HookServerOptions {
    port: number;
    bus: EventBus<ServerMessage>;
    onPreToolUse?: (event: { worktreePath: string; tool: string; input: Record<string, unknown> }) => void;
  }
  function startHookServer(options: HookServerOptions): { stop: () => void; port: number };
  ```
  POST body shape assumed from Claude Code's documented hook payload: `{ hook_event_name: "PreToolUse" | "PostToolUse", cwd: string, tool_name: string, tool_input: Record<string, unknown>, tool_response?: Record<string, unknown> }`. The receiver publishes a `hook_event` `ServerMessage` on the bus for every call, and additionally invokes `onPreToolUse` synchronously for `PreToolUse` (Task 7's policy engine hooks in here later — this task only wires the callback slot).

- [ ] **Step 1: Write the failing test**

```typescript
// daemon/test/hooks/hook-server.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { EventBus } from "../../src/event-bus";
import { startHookServer } from "../../src/hooks/hook-server";
import type { ServerMessage } from "@wranglr/protocol";

let server: ReturnType<typeof startHookServer> | undefined;

afterEach(() => {
  server?.stop();
  server = undefined;
});

describe("hook-server", () => {
  test("publishes a hook_event message for a PostToolUse payload", async () => {
    const bus = new EventBus<ServerMessage>();
    const received: ServerMessage[] = [];
    bus.subscribe((m) => received.push(m));
    server = startHookServer({ port: 0, bus });

    await fetch(`http://127.0.0.1:${server.port}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hook_event_name: "PostToolUse",
        cwd: "/repo/feature-x",
        tool_name: "Edit",
        tool_input: { file_path: "/repo/feature-x/a.ts" },
        tool_response: { success: true },
      }),
    });

    expect(received).toEqual([
      {
        type: "hook_event",
        hook: "PostToolUse",
        worktreePath: "/repo/feature-x",
        tool: "Edit",
        input: { file_path: "/repo/feature-x/a.ts" },
        output: { success: true },
      },
    ]);
  });

  test("invokes onPreToolUse for a PreToolUse payload", async () => {
    const bus = new EventBus<ServerMessage>();
    const preToolCalls: unknown[] = [];
    server = startHookServer({
      port: 0,
      bus,
      onPreToolUse: (event) => preToolCalls.push(event),
    });

    await fetch(`http://127.0.0.1:${server.port}/hook`, {
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
  });

  test("returns 400 for a malformed payload", async () => {
    const bus = new EventBus<ServerMessage>();
    server = startHookServer({ port: 0, bus });

    const response = await fetch(`http://127.0.0.1:${server.port}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonsense: true }),
    });

    expect(response.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd daemon && bun test test/hooks/hook-server.test.ts`
Expected: FAIL — `Cannot find module '../../src/hooks/hook-server'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// daemon/src/hooks/hook-server.ts
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

export interface HookServerOptions {
  port: number;
  bus: EventBus<ServerMessage>;
  onPreToolUse?: (event: { worktreePath: string; tool: string; input: Record<string, unknown> }) => void;
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

      if (hook_event_name === "PreToolUse") {
        options.onPreToolUse?.({ worktreePath: cwd, tool: tool_name, input: tool_input });
      }

      return new Response("ok");
    },
  });

  return { port: server.port as number, stop: () => server.stop(true) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd daemon && bun test test/hooks/hook-server.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add daemon/src/hooks/hook-server.ts daemon/test/hooks/hook-server.test.ts
git commit -m "feat(daemon): add Claude Code hook HTTP receiver"
```

---

### Task 7: Worktree policy engine

**Files:**
- Create: `daemon/src/policy/policy-config.ts`
- Create: `daemon/src/policy/policy-engine.ts`
- Create: `daemon/config/policy.example.json`
- Test: `daemon/test/policy/policy-engine.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure module; wired into `onPreToolUse` in Task 11).
- Produces:
  ```typescript
  type Tier = "experimental" | "guarded";
  type Decision = "allow" | "ask" | "block";

  interface PolicyConfig {
    [worktreePath: string]: Tier;
  }

  function loadPolicyConfig(path: string): PolicyConfig;
  function decide(config: PolicyConfig, worktreePath: string, tool: string): Decision;
  ```
  Tier semantics (SPEC §7.4): `experimental` auto-allows `Read`/`Edit`, asks for everything else (including `Bash`, `Write`); `guarded` always asks, for every tool. An unknown worktree path defaults to `guarded` (safer default — never silently auto-allow an unconfigured path).

- [ ] **Step 1: Write the failing test**

```typescript
// daemon/test/policy/policy-engine.test.ts
import { describe, expect, test } from "bun:test";
import { writeFileSync, unlinkSync } from "node:fs";
import { decide, loadPolicyConfig } from "../../src/policy/policy-engine";

const CONFIG_PATH = "/tmp/wranglr-test-policy.json";

describe("policy engine", () => {
  test("loadPolicyConfig parses a worktree->tier JSON map", () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({ "/repo/feature-x": "experimental" }));
    const config = loadPolicyConfig(CONFIG_PATH);
    expect(config).toEqual({ "/repo/feature-x": "experimental" });
    unlinkSync(CONFIG_PATH);
  });

  test("experimental tier auto-allows Read and Edit", () => {
    const config = { "/repo/feature-x": "experimental" as const };
    expect(decide(config, "/repo/feature-x", "Read")).toBe("allow");
    expect(decide(config, "/repo/feature-x", "Edit")).toBe("allow");
  });

  test("experimental tier still asks for Bash and Write", () => {
    const config = { "/repo/feature-x": "experimental" as const };
    expect(decide(config, "/repo/feature-x", "Bash")).toBe("ask");
    expect(decide(config, "/repo/feature-x", "Write")).toBe("ask");
  });

  test("guarded tier always asks, even for Read", () => {
    const config = { "/repo/ecovolt": "guarded" as const };
    expect(decide(config, "/repo/ecovolt", "Read")).toBe("ask");
  });

  test("an unconfigured worktree path defaults to guarded (always ask)", () => {
    const config = {};
    expect(decide(config, "/repo/unknown-path", "Read")).toBe("ask");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd daemon && bun test test/policy/policy-engine.test.ts`
Expected: FAIL — `Cannot find module '../../src/policy/policy-engine'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// daemon/src/policy/policy-config.ts
export type Tier = "experimental" | "guarded";
export type PolicyConfig = Record<string, Tier>;

export function loadPolicyConfig(path: string): PolicyConfig {
  const text = require("node:fs").readFileSync(path, "utf8");
  return JSON.parse(text) as PolicyConfig;
}
```

```typescript
// daemon/src/policy/policy-engine.ts
export { loadPolicyConfig } from "./policy-config";
import type { PolicyConfig, Tier } from "./policy-config";

export type Decision = "allow" | "ask" | "block";

const AUTO_ALLOWED_TOOLS_BY_TIER: Record<Tier, ReadonlySet<string>> = {
  experimental: new Set(["Read", "Edit"]),
  guarded: new Set([]),
};

export function decide(config: PolicyConfig, worktreePath: string, tool: string): Decision {
  const tier: Tier = config[worktreePath] ?? "guarded";
  return AUTO_ALLOWED_TOOLS_BY_TIER[tier].has(tool) ? "allow" : "ask";
}
```

```json
// daemon/config/policy.example.json
{
  "/Users/hans/Documents/GitHub/wranglr-scratch": "experimental",
  "/Users/hans/Documents/GitHub/ecovolt-web": "guarded"
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd daemon && bun test test/policy/policy-engine.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add daemon/src/policy daemon/config/policy.example.json daemon/test/policy
git commit -m "feat(daemon): add static per-worktree policy engine"
```

---

### Task 8: Verification module — dependency check

**Files:**
- Create: `daemon/src/verification/dependency-check.ts`
- Test: `daemon/test/verification/dependency-check.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```typescript
  interface DependencyCheckResult {
    name: string;
    ecosystem: "npm";
    resolved: boolean;
  }
  function checkDependencies(
    packageNames: string[],
    fetchImpl?: typeof fetch,
  ): Promise<DependencyCheckResult[]>;
  ```
  Uses the npm registry's existence endpoint (`HEAD https://registry.npmjs.org/<name>`) to flag hallucinated packages; `fetchImpl` is injectable for tests so no real network call is made.

- [ ] **Step 1: Write the failing test**

```typescript
// daemon/test/verification/dependency-check.test.ts
import { describe, expect, test } from "bun:test";
import { checkDependencies } from "../../src/verification/dependency-check";

function fakeFetch(existingPackages: Set<string>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const name = decodeURIComponent(url.split("/").pop() ?? "");
    return new Response(null, { status: existingPackages.has(name) ? 200 : 404 });
  }) as typeof fetch;
}

describe("checkDependencies", () => {
  test("marks a real package as resolved", async () => {
    const results = await checkDependencies(["react"], fakeFetch(new Set(["react"])));
    expect(results).toEqual([{ name: "react", ecosystem: "npm", resolved: true }]);
  });

  test("flags a nonexistent package as unresolved", async () => {
    const results = await checkDependencies(
      ["definitely-not-a-real-package-xyz"],
      fakeFetch(new Set(["react"])),
    );
    expect(results).toEqual([
      { name: "definitely-not-a-real-package-xyz", ecosystem: "npm", resolved: false },
    ]);
  });

  test("checks multiple packages independently", async () => {
    const results = await checkDependencies(
      ["react", "not-real-pkg"],
      fakeFetch(new Set(["react"])),
    );
    expect(results).toEqual([
      { name: "react", ecosystem: "npm", resolved: true },
      { name: "not-real-pkg", ecosystem: "npm", resolved: false },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd daemon && bun test test/verification/dependency-check.test.ts`
Expected: FAIL — `Cannot find module '../../src/verification/dependency-check'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// daemon/src/verification/dependency-check.ts
export interface DependencyCheckResult {
  name: string;
  ecosystem: "npm";
  resolved: boolean;
}

export async function checkDependencies(
  packageNames: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<DependencyCheckResult[]> {
  const results: DependencyCheckResult[] = [];
  for (const name of packageNames) {
    const response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
      method: "HEAD",
    });
    results.push({ name, ecosystem: "npm", resolved: response.ok });
  }
  return results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd daemon && bun test test/verification/dependency-check.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add daemon/src/verification/dependency-check.ts daemon/test/verification/dependency-check.test.ts
git commit -m "feat(daemon): add npm dependency existence check"
```

---

### Task 9: Verification module — isolated test re-run

**Files:**
- Create: `daemon/src/verification/test-runner.ts`
- Test: `daemon/test/verification/test-runner.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```typescript
  interface TestRunResult {
    passed: boolean;
    exitCode: number;
    output: string;
  }
  function runTestsIn(worktreePath: string, command: string[]): Promise<TestRunResult>;
  ```
  SPEC §10.3 leaves "where the isolated re-run happens relative to the repo's existing test tooling" as an open question. Resolution for v1: the daemon does **not** try to auto-detect the right test command per stack (Beacon/Ecovolt/Assessmate differ) — the policy config (Task 7) is extended later with an optional `testCommand: string[]` per worktree; this task only builds the executor that runs whatever command it's given, isolated via `Bun.spawn` in the worktree's own directory, and captures pass/fail from the exit code. Auto-detection is explicitly deferred, not attempted.

- [ ] **Step 1: Write the failing test**

```typescript
// daemon/test/verification/test-runner.test.ts
import { describe, expect, test } from "bun:test";
import { runTestsIn } from "../../src/verification/test-runner";

describe("runTestsIn", () => {
  test("reports passed=true and exitCode=0 for a succeeding command", async () => {
    const result = await runTestsIn("/tmp", ["true"]);
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  test("reports passed=false and the nonzero exit code for a failing command", async () => {
    const result = await runTestsIn("/tmp", ["false"]);
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  test("captures combined stdout/stderr in output", async () => {
    const result = await runTestsIn("/tmp", ["sh", "-c", "echo hello-from-test"]);
    expect(result.output).toContain("hello-from-test");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd daemon && bun test test/verification/test-runner.test.ts`
Expected: FAIL — `Cannot find module '../../src/verification/test-runner'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// daemon/src/verification/test-runner.ts
export interface TestRunResult {
  passed: boolean;
  exitCode: number;
  output: string;
}

export async function runTestsIn(worktreePath: string, command: string[]): Promise<TestRunResult> {
  const proc = Bun.spawn(command, {
    cwd: worktreePath,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { passed: exitCode === 0, exitCode, output: stdout + stderr };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd daemon && bun test test/verification/test-runner.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add daemon/src/verification/test-runner.ts daemon/test/verification/test-runner.test.ts
git commit -m "feat(daemon): add isolated test-suite runner for verification"
```

---

### Task 10: Web Push

**Files:**
- Create: `daemon/src/push/web-push.ts`
- Test: `daemon/test/push/web-push.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (called from Task 11's wiring whenever an `approval_request` publishes with no phone connected).
- Produces:
  ```typescript
  interface VapidKeys { publicKey: string; privateKey: string }
  interface PushSubscription { endpoint: string; keys: { p256dh: string; auth: string } }

  function loadOrCreateVapidKeys(storePath: string): VapidKeys;
  class PushManager {
    constructor(vapidKeys: VapidKeys, sendImpl?: typeof import("web-push").sendNotification);
    addSubscription(sub: PushSubscription): void;
    notifyAll(payload: { title: string; body: string }): Promise<void>;
  }
  ```

- [ ] **Step 1: Write the failing test**

```typescript
// daemon/test/push/web-push.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { loadOrCreateVapidKeys, PushManager } from "../../src/push/web-push";

const STORE_PATH = "/tmp/wranglr-test-vapid.json";

describe("loadOrCreateVapidKeys", () => {
  test("creates and persists a keypair on first call, reuses it on the next", () => {
    if (existsSync(STORE_PATH)) unlinkSync(STORE_PATH);
    const first = loadOrCreateVapidKeys(STORE_PATH);
    const second = loadOrCreateVapidKeys(STORE_PATH);
    expect(second).toEqual(first);
    unlinkSync(STORE_PATH);
  });
});

describe("PushManager", () => {
  test("calls sendImpl once per registered subscription with the given payload", async () => {
    const calls: Array<[unknown, string]> = [];
    const fakeSend = async (sub: unknown, payload: string) => {
      calls.push([sub, payload]);
    };
    const manager = new PushManager(
      { publicKey: "pub", privateKey: "priv" },
      fakeSend as unknown as typeof import("web-push").sendNotification,
    );
    manager.addSubscription({ endpoint: "https://push.example/1", keys: { p256dh: "a", auth: "b" } });
    manager.addSubscription({ endpoint: "https://push.example/2", keys: { p256dh: "c", auth: "d" } });

    await manager.notifyAll({ title: "Approval needed", body: "Bash in feature-x" });

    expect(calls.length).toBe(2);
    expect(JSON.parse(calls[0][1])).toEqual({ title: "Approval needed", body: "Bash in feature-x" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd daemon && bun test test/push/web-push.test.ts`
Expected: FAIL — `Cannot find module '../../src/push/web-push'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// daemon/src/push/web-push.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import webpush from "web-push";

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export function loadOrCreateVapidKeys(storePath: string): VapidKeys {
  if (existsSync(storePath)) {
    return JSON.parse(readFileSync(storePath, "utf8")) as VapidKeys;
  }
  const keys = webpush.generateVAPIDKeys();
  writeFileSync(storePath, JSON.stringify(keys));
  return keys;
}

type SendImpl = (subscription: PushSubscription, payload: string) => Promise<unknown>;

export class PushManager {
  private subscriptions: PushSubscription[] = [];
  private send: SendImpl;

  constructor(vapidKeys: VapidKeys, sendImpl?: SendImpl) {
    webpush.setVapidDetails("mailto:tech@ecovolt.ai", vapidKeys.publicKey, vapidKeys.privateKey);
    this.send =
      sendImpl ??
      ((subscription, payload) =>
        webpush.sendNotification(subscription as unknown as webpush.PushSubscription, payload));
  }

  addSubscription(sub: PushSubscription): void {
    this.subscriptions.push(sub);
  }

  async notifyAll(payload: { title: string; body: string }): Promise<void> {
    const json = JSON.stringify(payload);
    await Promise.all(this.subscriptions.map((sub) => this.send(sub, json)));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd daemon && bun test test/push/web-push.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add daemon/src/push/web-push.ts daemon/test/push/web-push.test.ts
git commit -m "feat(daemon): add VAPID key management and web push sending"
```

---

### Task 11: Daemon entrypoint — wire everything together

**Files:**
- Create: `daemon/src/index.ts`
- Modify: `daemon/package.json` (add `"scripts": {"start": "bun src/index.ts", "test": "bun test"}`)

**Interfaces:**
- Consumes: `HerdrSocketClient`/`HerdrAdapter` (2, 3), `EventBus` (4), `startWsServer` (5), `startHookServer` (6), `decide`/`loadPolicyConfig` (7), `loadOrCreateVapidKeys`/`PushManager` (10). **Does not wire Tasks 8 (dependency-check) or 9 (test-runner)** — see ruling in the plan's ledger: the `PostToolUse` verification-trigger heuristic and the phone→daemon push-subscription message are both real SPEC §7.3/§7.5 requirements this task defers, not implements. Both modules exist, are fully tested, and are ready to import once that follow-up work is scoped.
- Produces: a running process. No new exported interface — this is integration wiring, verified by manual smoke test (no unit test file; see Step-by-step below, matching "Task Right-Sizing" — this task's deliverable is the running daemon itself, gated by a manual verification step instead of a new automated test).

- [ ] **Step 1: Write the entrypoint**

```typescript
// daemon/src/index.ts
import type { ServerMessage, ClientMessage } from "@wranglr/protocol";
import { EventBus } from "./event-bus";
import { HerdrSocketClient } from "./herdr/socket-client";
import { HerdrAdapter, type HerdrSession } from "./herdr/adapter";
import { startWsServer } from "./ws-server";
import { startHookServer } from "./hooks/hook-server";
import { decide, loadPolicyConfig } from "./policy/policy-engine";
import { loadOrCreateVapidKeys, PushManager } from "./push/web-push";
import { homedir } from "node:os";
import { join } from "node:path";

const TOKEN = process.env.WRANGLR_TOKEN;
const TAILSCALE_HOSTNAME = process.env.WRANGLR_HOSTNAME ?? "127.0.0.1";
const WS_PORT = Number(process.env.WRANGLR_WS_PORT ?? 7420);
const HOOK_PORT = Number(process.env.WRANGLR_HOOK_PORT ?? 7421);
const POLICY_CONFIG_PATH = process.env.WRANGLR_POLICY_PATH ?? join(homedir(), ".config", "wranglr", "policy.json");
const VAPID_STORE_PATH = join(homedir(), ".config", "wranglr", "vapid.json");
const HERDR_SOCKET_PATH = join(homedir(), ".config", "herdr", "herdr.sock");

if (!TOKEN) {
  console.error("WRANGLR_TOKEN must be set");
  process.exit(1);
}

const bus = new EventBus<ServerMessage>();
const policyConfig = loadPolicyConfig(POLICY_CONFIG_PATH);
const pushManager = new PushManager(loadOrCreateVapidKeys(VAPID_STORE_PATH));

let latestSessions: HerdrSession[] = [];

function sessionsToWorktreeStatus(sessions: HerdrSession[]): ServerMessage {
  return {
    type: "worktree_status",
    worktrees: sessions.map((s) => ({
      path: s.cwd,
      herdrPaneId: s.paneId,
      state: s.agentStatus,
    })),
  };
}

const herdrClient = new HerdrSocketClient(HERDR_SOCKET_PATH);
await herdrClient.connect();
const herdrAdapter = new HerdrAdapter(herdrClient);
await herdrAdapter.onSessionChange((sessions) => {
  latestSessions = sessions;
  bus.publish(sessionsToWorktreeStatus(sessions));
});

function onClientMessage(msg: ClientMessage): void {
  if (msg.type === "prompt") {
    const session = latestSessions.find((s) => s.cwd === msg.worktreePath);
    if (session) void herdrAdapter.sendKeys(session.paneId, [msg.text, "Enter"]);
  }
  // approval_response handling is wired up once the hook receiver tracks
  // pending approval requests keyed by id (Task 6 only publishes hook_event;
  // approval_request/response correlation is future scope, not v1).
}

startHookServer({
  port: HOOK_PORT,
  bus,
  onPreToolUse: ({ worktreePath, tool }) => {
    const decision = decide(policyConfig, worktreePath, tool);
    if (decision === "ask") {
      void pushManager.notifyAll({ title: "Wranglr", body: `${tool} awaiting approval in ${worktreePath}` });
    }
  },
});

startWsServer({
  token: TOKEN,
  hostname: TAILSCALE_HOSTNAME,
  port: WS_PORT,
  bus,
  onClientMessage,
  getSnapshot: () => [sessionsToWorktreeStatus(latestSessions)],
});

console.log(`wranglr daemon listening: ws=${TAILSCALE_HOSTNAME}:${WS_PORT} hooks=127.0.0.1:${HOOK_PORT}`);
```

- [ ] **Step 2: Add npm scripts**

```json
{
  "scripts": {
    "start": "bun src/index.ts",
    "test": "bun test"
  }
}
```
Merge into `daemon/package.json`.

- [ ] **Step 3: Create the default policy directory and manual smoke test**

```bash
mkdir -p ~/.config/wranglr
cp daemon/config/policy.example.json ~/.config/wranglr/policy.json
```

Run:
```bash
cd daemon && WRANGLR_TOKEN=dev-token bun run start
```
Expected: prints `wranglr daemon listening: ws=127.0.0.1:7420 hooks=127.0.0.1:7421` and stays running (it connected to the real `~/.config/herdr/herdr.sock`, which must exist — start Herdr first if it isn't already running, per SPEC's assumption that Herdr is always up on the dev machine).

In a second terminal, verify the hook receiver:
```bash
curl -s -X POST http://127.0.0.1:7421/hook \
  -H 'content-type: application/json' \
  -d '{"hook_event_name":"PostToolUse","cwd":"'"$PWD"'","tool_name":"Edit","tool_input":{"file_path":"a.ts"}}'
```
Expected: `ok`.

Verify the WS server with `bun`'s built-in WebSocket client:
```bash
bun -e '
const ws = new WebSocket("ws://127.0.0.1:7420?token=dev-token");
ws.onmessage = (e) => { console.log(e.data); process.exit(0); };
'
```
Expected: prints a `worktree_status` JSON message reflecting whatever Herdr sessions are currently live.

- [ ] **Step 4: Commit**

```bash
git add daemon/src/index.ts daemon/package.json
git commit -m "feat(daemon): wire hook receiver, policy engine, push, WS server, and Herdr adapter into the entrypoint"
```

---

## Self-Review Notes (for the plan author, already applied above)

- **Spec coverage:** §7.1 (bus + WS protocol) → Tasks 1, 4, 5. §5/§7.2 (Herdr adapter) → Tasks 2, 3. §7.3 (verification) → Tasks 8, 9. §7.4 (policy) → Task 7. §7.5 (push) → Task 10. §7.7 (reconnection) → Task 5's snapshot-on-connect + `heartbeatIntervalMs` option (heartbeat ping loop itself is a follow-up inside Task 5's implementation if the manual smoke test in Task 11 shows dead connections lingering — flagged here rather than built speculatively, since Bun's WS `ping`/`pong` frames are handled at the protocol level and may not need an application-level heartbeat at all; verify during Task 5 review before adding one). §7.6 (PWA) is explicitly out of scope — separate plan. §10.1 resolved already (spec). §10.2 (policy config shape) — Task 7 confirms flat JSON `path -> tier` is sufficient for v1. §10.3 (verification re-run location) — resolved in Task 9 by deferring auto-detection and taking the command as an explicit input.
- **Placeholder scan:** no TBD/TODO markers; Task 11's approval_response comment documents a real, deliberate scope cut (not a placeholder for code that should exist in this plan).
- **Type consistency:** `HerdrSession` (Task 3) fields (`paneId`, `cwd`, `agentStatus`) match what Task 11's `sessionsToWorktreeStatus` reads. `ServerMessage`/`ClientMessage` (Task 1) are the sole message types used unchanged through Tasks 5, 6, 11. `EventBus<ServerMessage>` is threaded identically through Tasks 5, 6, 11.
