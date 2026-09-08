import { ServerMessageSchema, type ClientMessage, type ServerMessage } from "@wranglr/protocol";

export type ConnectionStatus = "connecting" | "open" | "closed";

export interface WranglrWsClientHandlers {
  onMessage: (msg: ServerMessage) => void;
  onStatusChange: (status: ConnectionStatus) => void;
}

export class WranglrWsClient {
  private socket: WebSocket | null = null;
  private closedByUser = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = 500;
  private queuedMessages: string[] = [];

  constructor(url: string, private handlers: WranglrWsClientHandlers) {
    this.url = url;
    this.connect();
  }

  private url: string;

  private connect(): void {
    if (this.closedByUser) return;
    this.handlers.onStatusChange("connecting");
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.reconnectDelayMs = 500;
      this.handlers.onStatusChange("open");
      for (const message of this.queuedMessages.splice(0)) socket.send(message);
    });
    socket.addEventListener("close", () => {
      if (this.socket === socket) this.socket = null;
      if (this.closedByUser) return;
      this.handlers.onStatusChange("closed");
      const delay = this.reconnectDelayMs;
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 10_000);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
    socket.addEventListener("message", (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const result = ServerMessageSchema.safeParse(parsed);
      if (result.success) this.handlers.onMessage(result.data);
    });
  }

  send(msg: ClientMessage): void {
    const serialized = JSON.stringify(msg);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(serialized);
    } else {
      this.queuedMessages.push(serialized);
    }
  }

  close(): void {
    if (this.closedByUser) return;
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.queuedMessages = [];
    this.socket?.close();
    this.socket = null;
    this.handlers.onStatusChange("closed");
  }
}
