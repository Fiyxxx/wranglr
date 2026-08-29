import { ClientMessageSchema, type ClientMessage, type ServerMessage } from "@wranglr/protocol";
import type { EventBus } from "./event-bus";

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

      if (req.method === "POST" && url.pathname === "/push-subscribe") {
        return req.json().then((body) => {
          options.onPushSubscribe(body as { endpoint: string; keys: { p256dh: string; auth: string } });
          return new Response(null, { status: 204 });
        }).catch(() => {
          return new Response("bad request", { status: 400 });
        });
      }

      if (req.method === "GET" && url.pathname === "/vapid-public-key") {
        return Response.json({ publicKey: options.vapidPublicKey });
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

  return {
    port: server.port as number,
    stop: () => server.stop(true),
  };
}
