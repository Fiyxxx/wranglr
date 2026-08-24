import type { HerdrIncoming } from "./types";

export class HerdrSocketClient {
  private socketPath: string;
  private nextId = 1;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  async request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = String(this.nextId++);
    let buffer = "";
    let resolved = false;

    return new Promise<T>(async (resolve, reject) => {
      try {
        const socket = await Bun.connect({
          unix: this.socketPath,
          socket: {
            open: (sock) => {
              sock.write(JSON.stringify({ id, method, params }) + "\n");
            },
            data: (_socket, chunk) => {
              buffer += chunk.toString("utf8");
              let newlineIndex: number;
              while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
                const line = buffer.slice(0, newlineIndex);
                buffer = buffer.slice(newlineIndex + 1);
                if (line.trim().length === 0) continue;

                const msg = JSON.parse(line) as HerdrIncoming;

                // Should be a response with matching id
                if ("id" in msg && msg.id === id) {
                  resolved = true;
                  _socket.end();

                  if ("error" in msg) {
                    reject(new Error(msg.error.message));
                  } else {
                    resolve(msg.result as T);
                  }
                  return;
                }
              }
            },
            error: (_socket, error) => {
              if (!resolved) {
                resolved = true;
                reject(error);
              }
            },
            close: () => {
              if (!resolved) {
                resolved = true;
                reject(new Error("herdr socket closed before response"));
              }
            },
          },
        });
      } catch (err) {
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      }
    });
  }

  async subscribe(
    subscriptions: Record<string, unknown>[],
    onEvent: (event: string, data: Record<string, unknown>) => void,
  ): Promise<() => void> {
    const id = String(this.nextId++);
    let buffer = "";
    let connected = false;
    let subscriptionSocket: any;

    return new Promise(async (resolve, reject) => {
      try {
        subscriptionSocket = await Bun.connect({
          unix: this.socketPath,
          socket: {
            open: (sock) => {
              sock.write(
                JSON.stringify({ id, method: "events.subscribe", params: { subscriptions } }) + "\n",
              );
            },
            data: (_socket, chunk) => {
              buffer += chunk.toString("utf8");
              let newlineIndex: number;
              while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
                const line = buffer.slice(0, newlineIndex);
                buffer = buffer.slice(newlineIndex + 1);
                if (line.trim().length === 0) continue;

                const msg = JSON.parse(line) as HerdrIncoming;

                // Check if this is the ack response
                if ("id" in msg && msg.id === id) {
                  if ("error" in msg) {
                    _socket.end();
                    reject(new Error(msg.error.message));
                    return;
                  }
                  connected = true;
                  resolve(() => {
                    if (subscriptionSocket) {
                      subscriptionSocket.end();
                      subscriptionSocket = null;
                    }
                  });
                } else if ("event" in msg) {
                  // This is a pushed event
                  onEvent(msg.event, msg.data);
                }
              }
            },
            error: (_socket, error) => {
              if (!connected) {
                subscriptionSocket = null;
                reject(error);
              }
            },
            close: () => {
              subscriptionSocket = null;
            },
          },
        });
      } catch (err) {
        reject(err);
      }
    });
  }
}
