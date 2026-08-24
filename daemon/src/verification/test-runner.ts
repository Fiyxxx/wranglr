export interface TestRunResult {
  passed: boolean;
  exitCode: number;
  output: string;
}

export async function runTestsIn(worktreePath: string, command: string[]): Promise<TestRunResult> {
  const proc = Bun.spawn(command, {
    cwd: worktreePath,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { passed: exitCode === 0, exitCode, output: stdout + stderr };
}
