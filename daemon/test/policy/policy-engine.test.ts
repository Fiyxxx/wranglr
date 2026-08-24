import { describe, expect, test } from "bun:test";
import { writeFileSync, unlinkSync } from "node:fs";
import { decide, loadPolicyConfig } from "../../src/policy/policy-engine";

const CONFIG_PATH = "/tmp/wranglr-test-policy.json";

describe("policy engine", () => {
  test("loadPolicyConfig parses a worktree->tier JSON map", () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({ "/repo/feature-x": "experimental" }));
    const config = loadPolicyConfig(CONFIG_PATH);
    expect(config).toEqual({ "/repo/feature-x": "experimental" });
    unlinkSync(CONFIG_PATH);
  });

  test("experimental tier auto-allows Read and Edit", () => {
    const config = { "/repo/feature-x": "experimental" as const };
    expect(decide(config, "/repo/feature-x", "Read")).toBe("allow");
    expect(decide(config, "/repo/feature-x", "Edit")).toBe("allow");
  });

  test("experimental tier still asks for Bash and Write", () => {
    const config = { "/repo/feature-x": "experimental" as const };
    expect(decide(config, "/repo/feature-x", "Bash")).toBe("ask");
    expect(decide(config, "/repo/feature-x", "Write")).toBe("ask");
  });

  test("guarded tier always asks, even for Read", () => {
    const config = { "/repo/ecovolt": "guarded" as const };
    expect(decide(config, "/repo/ecovolt", "Read")).toBe("ask");
  });

  test("an unconfigured worktree path defaults to guarded (always ask)", () => {
    const config = {};
    expect(decide(config, "/repo/unknown-path", "Read")).toBe("ask");
  });
});
