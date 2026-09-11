import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const configDir = join(homedir(), ".config", "wranglr");
const tokenPath = join(configDir, "token");
const policyPath = process.env.WRANGLR_POLICY_PATH ?? join(configDir, "policy.json");

function envPort(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return value;
}

async function run(command: string[], cwd = repoRoot): Promise<void> {
  const child = Bun.spawn(command, {
    cwd,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`Command failed (${exitCode}): ${command.join(" ")}`);
  }
}

/** Best-effort LAN IPv4 address so a phone on the same Wi-Fi can reach this machine. */
function detectLanAddress(): string | null {
  const interfaces = networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return null;
}

function loadOrCreateToken(): string {
  mkdirSync(configDir, { recursive: true });
  const fromEnvironment = process.env.WRANGLR_TOKEN?.trim();
  const fromDisk = existsSync(tokenPath) ? readFileSync(tokenPath, "utf8").trim() : "";
  const token = fromEnvironment || fromDisk || randomBytes(32).toString("hex");
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
  return token;
}

function ensurePolicy(): void {
  mkdirSync(dirname(policyPath), { recursive: true });
  if (!existsSync(policyPath)) writeFileSync(policyPath, "{}\n", { mode: 0o600 });
}

async function main(): Promise<void> {
  const wsPort = envPort("WRANGLR_WS_PORT", 7420);
  const hookPort = envPort("WRANGLR_HOOK_PORT", 7421);
  const pwaPort = envPort("WRANGLR_PWA_PORT", 3000);
  const token = loadOrCreateToken();
  ensurePolicy();

  console.log("\nPreparing Wranglr…");
  await run([process.execPath, "install"]);
  await run([process.execPath, "run", "--cwd", "pwa", "build"]);

  const publicHostname = process.env.WRANGLR_PUBLIC_HOST ?? detectLanAddress() ?? "127.0.0.1";
  const secure = process.env.WRANGLR_SECURE === "true";
  const phoneUrl = `${secure ? "https" : "http"}://${publicHostname}:${pwaPort}`;

  if (publicHostname === "127.0.0.1") {
    console.log(
      "Could not detect a LAN address; falling back to 127.0.0.1 (only reachable from this machine). " +
        "Set WRANGLR_PUBLIC_HOST to this machine's LAN IP to pair a phone.",
    );
  }

  const serviceEnvironment = {
    ...process.env,
    WRANGLR_TOKEN: token,
    WRANGLR_BIND_HOST: process.env.WRANGLR_BIND_HOST ?? "0.0.0.0",
    WRANGLR_PUBLIC_HOST: publicHostname,
    WRANGLR_PUBLIC_PORT: String(wsPort),
    WRANGLR_SECURE: String(secure),
    WRANGLR_WS_PORT: String(wsPort),
    WRANGLR_HOOK_PORT: String(hookPort),
    WRANGLR_POLICY_PATH: policyPath,
    WRANGLR_PWA_HOST: process.env.WRANGLR_PWA_HOST ?? "0.0.0.0",
    WRANGLR_PWA_PORT: String(pwaPort),
  };

  console.log(`\nPhone URL: ${phoneUrl}`);
  console.log("Make sure your phone is on the same Wi-Fi network as this machine.");
  console.log(`Policy: ${policyPath}`);
  console.log("Starting the PWA and daemon. Press Ctrl+C to stop both.\n");

  const pwa = Bun.spawn([process.execPath, join(repoRoot, "pwa", "serve.ts")], {
    cwd: repoRoot,
    env: serviceEnvironment,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const daemon = Bun.spawn([process.execPath, join(repoRoot, "daemon", "src", "index.ts")], {
    cwd: repoRoot,
    env: serviceEnvironment,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  let stopping = false;
  let requestedStop = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    pwa.kill();
    daemon.kill();
  };
  const handleSignal = () => {
    requestedStop = true;
    stop();
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  const exited = await Promise.race([
    pwa.exited.then((exitCode) => ({ name: "PWA", exitCode })),
    daemon.exited.then((exitCode) => ({ name: "daemon", exitCode })),
  ]);
  stop();
  await Promise.allSettled([pwa.exited, daemon.exited]);

  if (!requestedStop) {
    throw new Error(`${exited.name} exited with code ${exited.exitCode}`);
  }
}

main().catch((error) => {
  console.error(`\nWranglr could not start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
