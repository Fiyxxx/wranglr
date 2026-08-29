import { describe, expect, test } from "bun:test";
import { assessRisk } from "../../src/approvals/risk";

describe("assessRisk", () => {
  test("classifies destructive/execution tools as high", () => {
    expect(assessRisk("Bash")).toBe("high");
    expect(assessRisk("Write")).toBe("high");
    expect(assessRisk("MultiEdit")).toBe("high");
    expect(assessRisk("NotebookEdit")).toBe("high");
  });

  test("classifies Edit as medium", () => {
    expect(assessRisk("Edit")).toBe("medium");
  });

  test("classifies read-only tools as low", () => {
    expect(assessRisk("Read")).toBe("low");
    expect(assessRisk("Glob")).toBe("low");
    expect(assessRisk("Grep")).toBe("low");
    expect(assessRisk("WebFetch")).toBe("low");
    expect(assessRisk("WebSearch")).toBe("low");
  });

  test("defaults unknown tools to medium", () => {
    expect(assessRisk("SomeFutureTool")).toBe("medium");
  });
});
