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
