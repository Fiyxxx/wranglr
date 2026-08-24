export type Tier = "experimental" | "guarded";
export type PolicyConfig = Record<string, Tier>;

export function loadPolicyConfig(path: string): PolicyConfig {
  const text = require("node:fs").readFileSync(path, "utf8");
  return JSON.parse(text) as PolicyConfig;
}
