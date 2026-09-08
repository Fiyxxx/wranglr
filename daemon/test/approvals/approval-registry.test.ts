import { describe, expect, test } from "bun:test";
import { ApprovalRegistry } from "../../src/approvals/approval-registry";

describe("ApprovalRegistry", () => {
  test("resolves with the responded decision", async () => {
    const registry = new ApprovalRegistry();
    const pending = registry.request("req-1", 5_000);
    const responded = registry.respond("req-1", "approve");
    expect(responded).toBe(true);
    expect(await pending).toBe("approve");
  });

  test("resolves with reject when responded with reject", async () => {
    const registry = new ApprovalRegistry();
    const pending = registry.request("req-2", 5_000);
    registry.respond("req-2", "reject");
    expect(await pending).toBe("reject");
  });

  test("respond returns false for an unknown id", () => {
    const registry = new ApprovalRegistry();
    expect(registry.respond("nonexistent", "approve")).toBe(false);
  });

  test("resolves with timeout when nothing responds", async () => {
    const registry = new ApprovalRegistry();
    const pending = registry.request("req-3", 10);
    expect(await pending).toBe("timeout");
  });

  test("a late respond after timeout is a no-op (returns false)", async () => {
    const registry = new ApprovalRegistry();
    const pending = registry.request("req-4", 10);
    expect(await pending).toBe("timeout");
    expect(registry.respond("req-4", "approve")).toBe(false);
  });
});
