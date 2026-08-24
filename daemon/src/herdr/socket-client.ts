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
