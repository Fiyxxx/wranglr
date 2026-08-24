export interface DependencyCheckResult {
  name: string;
  ecosystem: "npm";
  resolved: boolean;
}

export async function checkDependencies(
  packageNames: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<DependencyCheckResult[]> {
  const results: DependencyCheckResult[] = [];
  for (const name of packageNames) {
    const response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
      method: "HEAD",
    });
    results.push({ name, ecosystem: "npm", resolved: response.ok });
  }
  return results;
}
