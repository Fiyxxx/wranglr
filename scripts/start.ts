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

async function capture(command: string[]): Promise<string> {
  const child = Bun.spawn(command, {
    cwd: repoRoot,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `Command failed (${exitCode}): ${command.join(" ")}`);
  }
  return stdout;
}

function findTailscale(): string | null {
  const candidates = [
    Bun.which("tailscale"),
    "/opt/homebrew/bin/tailscale",
    "/usr/local/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/tailscale",
  ];
  return (
    candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate))) ?? null
  );
}

async function tailscaleHostname(tailscale: string): Promise<string> {
  if (process.env.WRANGLR_PUBLIC_HOST) return process.env.WRANGLR_PUBLIC_HOST;

  const status = JSON.parse(await capture([tailscale, "status", "--json"])) as {
    BackendState?: string;
    Self?: { DNSName?: string };
  };
  if (status.BackendState && status.BackendState !== "Running") {
    throw new Error("Tailscale is not connected. Connect it, then run bun run start again.");
  }
  const hostname = status.Self?.DNSName?.replace(/\.$/, "");
  if (!hostname) {
    throw new Error("Tailscale did not report a MagicDNS hostname. Check that Tailscale is connected.");
  }
  return hostname;
}

/** Best-effort LAN IPv4 address, used when running with WRANGLR_SKIP_TAILSCALE=true. */
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
  const skipTailscale = process.env.WRANGLR_SKIP_TAILSCALE === "true";
  const publicPort = envPort("WRANGLR_PUBLIC_PORT", skipTailscale ? wsPort : 8443);
  const token = loadOrCreateToken();
  ensurePolicy();

  const tailscale = skipTailscale ? null : findTailscale();
  if (!skipTailscale && !tailscale) {
    throw new Error(
      "Tailscale CLI was not found. Install/enable it for phone access, or run local-only with WRANGLR_SKIP_TAILSCALE=true bun run start",
    );
  }

  console.log("\nPreparing Wranglr…");
  await run([process.execPath, "install"]);
  await run([process.execPath, "run", "--cwd", "pwa", "build"]);

  let publicHostname: string;
  let secure: boolean;
  let phoneUrl: string;

  if (skipTailscale) {
    publicHostname = process.env.WRANGLR_PUBLIC_HOST ?? detectLanAddress() ?? "127.0.0.1";
    secure = process.env.WRANGLR_SECURE === "true";
    phoneUrl = `${secure ? "https" : "http"}://${publicHostname}:${pwaPort}`;
    console.log("Skipping Tailscale Serve (local-only mode). Phone must be on the same Wi-Fi network.");
  } else {
    // Checked above before doing the install and production build.
    if (!tailscale) throw new Error("Tailscale CLI was not found.");
    publicHostname = await tailscaleHostname(tailscale);
    secure = true;
    await run([tailscale, "serve", "--bg", "--https=443", `http://127.0.0.1:${pwaPort}`]);
    await run([tailscale, "serve", "--bg", `--https=${publicPort}`, `http://127.0.0.1:${wsPort}`]);
    phoneUrl = `https://${publicHostname}`;
  }

  const serviceEnvironment = {
    ...process.env,
    WRANGLR_TOKEN: token,
    WRANGLR_BIND_HOST: process.env.WRANGLR_BIND_HOST ?? (skipTailscale ? "0.0.0.0" : "127.0.0.1"),
    WRANGLR_PUBLIC_HOST: publicHostname,
    WRANGLR_PUBLIC_PORT: String(publicPort),
    WRANGLR_SECURE: String(secure),
    WRANGLR_WS_PORT: String(wsPort),
    WRANGLR_HOOK_PORT: String(hookPort),
    WRANGLR_POLICY_PATH: policyPath,
    WRANGLR_PWA_HOST: process.env.WRANGLR_PWA_HOST ?? (skipTailscale ? "0.0.0.0" : "127.0.0.1"),
    WRANGLR_PWA_PORT: String(pwaPort),
  };

  console.log(`\nPhone URL: ${phoneUrl}`);
  if (skipTailscale) console.log("Make sure your phone is on the same Wi-Fi network as this machine.");
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
