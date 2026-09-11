import { ClientMessageSchema, type ClientMessage, type ServerMessage } from "@wranglr/protocol";
import type { EventBus } from "./event-bus";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

const PushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});

export interface WsServerOptions {
  token: string;
  hostname: string;
  port: number;
  bus: EventBus<ServerMessage>;
  onClientMessage: (msg: ClientMessage) => void | Promise<void>;
  getSnapshot: () => ServerMessage[];
  onPushSubscribe: (sub: { endpoint: string; keys: { p256dh: string; auth: string } }) => void;
  vapidPublicKey: string;
  heartbeatIntervalMs?: number;
}

const AUTH_FAILURE_WINDOW_MS = 60_000;
const AUTH_FAILURE_LIMIT = 20;

function tokensMatch(candidate: string | null, expected: string): boolean {
  if (candidate === null) return false;
  const candidateBuf = Buffer.from(candidate);
  const expectedBuf = Buffer.from(expected);
  if (candidateBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(candidateBuf, expectedBuf);
}

export function startWsServer(options: WsServerOptions): { stop: () => void; port: number } {
  const unsubscribers = new Map<Bun.ServerWebSocket<unknown>, () => void>();
  const authFailures = new Map<string, { count: number; windowStart: number }>();
  const corsHeaders = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };

  function isRateLimited(ip: string): boolean {
    const now = Date.now();
    const entry = authFailures.get(ip);
    if (!entry || now - entry.windowStart > AUTH_FAILURE_WINDOW_MS) {
      authFailures.set(ip, { count: 1, windowStart: now });
      return false;
    }
    entry.count += 1;
    return entry.count > AUTH_FAILURE_LIMIT;
  }

  const server = Bun.serve({
    hostname: options.hostname,
    port: options.port,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }
      if (!tokensMatch(url.searchParams.get("token"), options.token)) {
        const ip = srv.requestIP(req)?.address ?? "unknown";
        if (isRateLimited(ip)) {
          return new Response("too many attempts", { status: 429, headers: corsHeaders });
        }
        return new Response("unauthorized", { status: 401, headers: corsHeaders });
      }

      if (req.method === "POST" && url.pathname === "/push-subscribe") {
        return req.json().then((body) => {
          const parsed = PushSubscriptionSchema.safeParse(body);
          if (!parsed.success) return new Response("bad request", { status: 400, headers: corsHeaders });
          options.onPushSubscribe(parsed.data);
          return new Response(null, { status: 204, headers: corsHeaders });
        }).catch(() => {
          return new Response("bad request", { status: 400, headers: corsHeaders });
        });
      }

      if (req.method === "GET" && url.pathname === "/vapid-public-key") {
        return Response.json({ publicKey: options.vapidPublicKey }, { headers: corsHeaders });
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
        if (result.success) {
          void Promise.resolve(options.onClientMessage(result.data)).catch((error) => {
            console.error("Failed to handle client message", error);
          });
        }
      },
      close(ws) {
        unsubscribers.get(ws)?.();
        unsubscribers.delete(ws);
      },
    },
  });

  const heartbeat = setInterval(() => {
    for (const ws of unsubscribers.keys()) ws.ping();
    const now = Date.now();
    for (const [ip, entry] of authFailures) {
      if (now - entry.windowStart > AUTH_FAILURE_WINDOW_MS) authFailures.delete(ip);
    }
  }, options.heartbeatIntervalMs ?? 15_000);

  return {
    port: server.port as number,
    stop: () => {
      clearInterval(heartbeat);
      server.stop(true);
    },
  };
}
