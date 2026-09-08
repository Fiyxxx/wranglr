import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(storePath, JSON.stringify(keys));
  return keys;
}

type SendImpl = (subscription: PushSubscription, payload: string) => Promise<unknown>;

export class PushManager {
  private subscriptions = new Map<string, PushSubscription>();
  private send: SendImpl;
  private publicKey: string;
  private storePath?: string;

  constructor(
    vapidKeys: VapidKeys,
    sendImpl?: SendImpl,
    storePath?: string,
    vapidSubject = "mailto:wranglr@example.com",
  ) {
    // Only set VAPID details when using real sendNotification; tests inject mocks with fake keys that would fail webpush's validation.
    if (!sendImpl) {
      webpush.setVapidDetails(vapidSubject, vapidKeys.publicKey, vapidKeys.privateKey);
    }
    this.publicKey = vapidKeys.publicKey;
    this.storePath = storePath;
    if (storePath && existsSync(storePath)) {
      const saved = JSON.parse(readFileSync(storePath, "utf8")) as PushSubscription[];
      for (const subscription of saved) this.subscriptions.set(subscription.endpoint, subscription);
    }
    this.send =
      sendImpl ??
      ((subscription, payload) =>
        webpush.sendNotification(subscription as unknown as webpush.PushSubscription, payload));
  }

  get vapidPublicKey(): string {
    return this.publicKey;
  }

  addSubscription(sub: PushSubscription): void {
    this.subscriptions.set(sub.endpoint, sub);
    if (this.storePath) {
      mkdirSync(dirname(this.storePath), { recursive: true });
      writeFileSync(this.storePath, JSON.stringify([...this.subscriptions.values()]));
    }
  }

  async notifyAll(payload: { title: string; body: string }): Promise<void> {
    const json = JSON.stringify(payload);
    await Promise.all([...this.subscriptions.values()].map((sub) => this.send(sub, json)));
  }
}
