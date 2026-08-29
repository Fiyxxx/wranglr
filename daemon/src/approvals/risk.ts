export type Risk = "low" | "medium" | "high";

const HIGH = new Set(["Bash", "Write", "MultiEdit", "NotebookEdit"]);
const MEDIUM = new Set(["Edit"]);
const LOW = new Set(["Read", "Glob", "Grep", "WebFetch", "WebSearch"]);

export function assessRisk(tool: string): Risk {
  if (HIGH.has(tool)) return "high";
  if (LOW.has(tool)) return "low";
  if (MEDIUM.has(tool)) return "medium";
  return "medium";
}
