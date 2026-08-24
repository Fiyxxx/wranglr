import { describe, expect, test } from "bun:test";
import { checkDependencies } from "../../src/verification/dependency-check";

function fakeFetch(existingPackages: Set<string>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const name = decodeURIComponent(url.split("/").pop() ?? "");
    return new Response(null, { status: existingPackages.has(name) ? 200 : 404 });
  }) as typeof fetch;
}

describe("checkDependencies", () => {
  test("marks a real package as resolved", async () => {
    const results = await checkDependencies(["react"], fakeFetch(new Set(["react"])));
    expect(results).toEqual([{ name: "react", ecosystem: "npm", resolved: true }]);
  });

  test("flags a nonexistent package as unresolved", async () => {
    const results = await checkDependencies(
      ["definitely-not-a-real-package-xyz"],
      fakeFetch(new Set(["react"])),
    );
    expect(results).toEqual([
      { name: "definitely-not-a-real-package-xyz", ecosystem: "npm", resolved: false },
    ]);
  });

  test("checks multiple packages independently", async () => {
    const results = await checkDependencies(
      ["react", "not-real-pkg"],
      fakeFetch(new Set(["react"])),
    );
    expect(results).toEqual([
      { name: "react", ecosystem: "npm", resolved: true },
      { name: "not-real-pkg", ecosystem: "npm", resolved: false },
    ]);
  });
});
