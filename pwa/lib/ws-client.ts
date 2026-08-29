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
