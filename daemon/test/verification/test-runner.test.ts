import { describe, expect, test } from "bun:test";
import { runTestsIn } from "../../src/verification/test-runner";

describe("runTestsIn", () => {
  test("reports passed=true and exitCode=0 for a succeeding command", async () => {
    const result = await runTestsIn("/tmp", ["true"]);
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  test("reports passed=false and the nonzero exit code for a failing command", async () => {
    const result = await runTestsIn("/tmp", ["false"]);
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  test("captures combined stdout/stderr in output", async () => {
    const result = await runTestsIn("/tmp", ["sh", "-c", "echo hello-from-test"]);
    expect(result.output).toContain("hello-from-test");
  });
});
