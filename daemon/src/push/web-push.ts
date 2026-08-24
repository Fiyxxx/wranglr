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
    // Only set VAPID details when using real sendNotification; tests inject mocks with fake keys that would fail webpush's validation.
    if (!sendImpl) {
      webpush.setVapidDetails("mailto:tech@ecovolt.ai", vapidKeys.publicKey, vapidKeys.privateKey);
    }
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
