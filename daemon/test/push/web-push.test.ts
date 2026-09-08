import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { loadOrCreateVapidKeys, PushManager, type PushSubscription } from "../../src/push/web-push";

const STORE_PATH = "/tmp/wranglr-test-vapid.json";
const SUBSCRIPTIONS_PATH = "/tmp/wranglr-test-push-subscriptions.json";

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

  test("persists subscriptions and de-duplicates by endpoint", async () => {
    if (existsSync(SUBSCRIPTIONS_PATH)) unlinkSync(SUBSCRIPTIONS_PATH);
    const calls: PushSubscription[] = [];
    const send = async (subscription: PushSubscription) => { calls.push(subscription); };
    const first = new PushManager({ publicKey: "pub", privateKey: "priv" }, send, SUBSCRIPTIONS_PATH);
    first.addSubscription({ endpoint: "https://push.example/1", keys: { p256dh: "old", auth: "a" } });
    first.addSubscription({ endpoint: "https://push.example/1", keys: { p256dh: "new", auth: "b" } });

    const saved = JSON.parse(readFileSync(SUBSCRIPTIONS_PATH, "utf8"));
    expect(saved).toEqual([{ endpoint: "https://push.example/1", keys: { p256dh: "new", auth: "b" } }]);

    const restored = new PushManager({ publicKey: "pub", privateKey: "priv" }, send, SUBSCRIPTIONS_PATH);
    await restored.notifyAll({ title: "Test", body: "Test" });
    expect(calls).toEqual([{ endpoint: "https://push.example/1", keys: { p256dh: "new", auth: "b" } }]);
    unlinkSync(SUBSCRIPTIONS_PATH);
  });
});
