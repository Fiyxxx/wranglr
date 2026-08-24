export { loadPolicyConfig } from "./policy-config";
import type { PolicyConfig, Tier } from "./policy-config";

export type Decision = "allow" | "ask" | "block";

const AUTO_ALLOWED_TOOLS_BY_TIER: Record<Tier, ReadonlySet<string>> = {
  experimental: new Set(["Read", "Edit"]),
  guarded: new Set([]),
};

export function decide(config: PolicyConfig, worktreePath: string, tool: string): Decision {
  const tier: Tier = config[worktreePath] ?? "guarded";
  return AUTO_ALLOWED_TOOLS_BY_TIER[tier].has(tool) ? "allow" : "ask";
}
