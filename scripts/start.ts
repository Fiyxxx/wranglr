import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const configDir = join(homedir(), ".config", "wranglr");
const tokenPath = join(configDir, "token");
const policyPath = process.env.WRANGLR_POLICY_PATH ?? join(configDir, "policy.json");

type TunnelMode = "tailscale" | "cloudflare" | "none";

function resolveTunnelMode(): TunnelMode {
  const explicit = process.env.WRANGLR_TUNNEL?.trim().toLowerCase();
  if (explicit === "tailscale" || explicit === "cloudflare" || explicit === "none") return explicit;
  if (explicit) {
    throw new Error(`WRANGLR_TUNNEL must be "tailscale", "cloudflare", or "none" (got "${explicit}")`);
  }
  // Backward-compatible alias for the older local-only flag.
  if (process.env.WRANGLR_SKIP_TAILSCALE === "true") return "none";
  return "tailscale";
}

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

function findOnPath(name: string, extraCandidates: string[]): string | null {
  const candidates = [Bun.which(name), ...extraCandidates];
  return (
    candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate))) ?? null
  );
}

function findTailscale(): string | null {
  return findOnPath("tailscale", [
    "/opt/homebrew/bin/tailscale",
    "/usr/local/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/tailscale",
  ]);
}

function findCloudflared(): string | null {
  return findOnPath("cloudflared", ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"]);
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

/** Best-effort LAN IPv4 address, used in local-network-only mode (WRANGLR_TUNNEL=none). */
function detectLanAddress(): string | null {
  const interfaces = networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return null;
}

/**
 * Starts a Cloudflare Quick Tunnel (`cloudflared tunnel --url`) proxying to a local port and
 * resolves once it prints the assigned `*.trycloudflare.com` hostname. The process keeps running
 * in the background; callers are responsible for killing it on shutdown.
 */
async function startCloudflareTunnel(
  cloudflared: string,
  label: string,
  localPort: number,
): Promise<{ hostname: string; process: Bun.Subprocess }> {
  const child = Bun.spawn([cloudflared, "tunnel", "--url", `http://127.0.0.1:${localPort}`], {
    stdout: "ignore",
    stderr: "pipe",
  });

  let resolved = false;
  let buffer = "";
  const hostnamePromise = (async () => {
    const reader = child.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (resolved) continue; // keep draining to avoid backpressure, ignore content
        buffer += decoder.decode(value, { stream: true });
        const match = buffer.match(/https:\/\/([a-z0-9-]+\.trycloudflare\.com)/);
        if (match) {
          resolved = true;
          return match[1];
        }
      }
    } finally {
      reader.releaseLock();
    }
    throw new Error(`cloudflared (${label}) exited before printing a tunnel URL`);
  })();

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`Timed out waiting for cloudflared (${label}) to print a tunnel URL`)),
      20_000,
    ),
  );

  const hostname = await Promise.race([hostnamePromise, timeout]);
  return { hostname, process: child };
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
  const tunnelMode = resolveTunnelMode();
  const defaultPublicPort = tunnelMode === "tailscale" ? 8443 : tunnelMode === "cloudflare" ? 443 : wsPort;
  const publicPort = envPort("WRANGLR_PUBLIC_PORT", defaultPublicPort);
  const token = loadOrCreateToken();
  ensurePolicy();

  const tailscale = tunnelMode === "tailscale" ? findTailscale() : null;
  if (tunnelMode === "tailscale" && !tailscale) {
    throw new Error(
      "Tailscale CLI was not found. Install/enable it for phone access, or run WRANGLR_TUNNEL=cloudflare bun run start " +
        "(needs cloudflared instead) or WRANGLR_TUNNEL=none bun run start (same-Wi-Fi only, no extra install).",
    );
  }

  const cloudflared = tunnelMode === "cloudflare" ? findCloudflared() : null;
  if (tunnelMode === "cloudflare" && !cloudflared) {
    throw new Error(
      "cloudflared CLI was not found. Install it (e.g. `brew install cloudflared`), or use WRANGLR_TUNNEL=tailscale " +
        "or WRANGLR_TUNNEL=none instead.",
    );
  }

  console.log("\nPreparing Wranglr…");
  await run([process.execPath, "install"]);
  await run([process.execPath, "run", "--cwd", "pwa", "build"]);

  let publicHostname: string;
  let secure: boolean;
  let phoneUrl: string;
  const stopTunnels: Array<() => void> = [];

  if (tunnelMode === "none") {
    publicHostname = process.env.WRANGLR_PUBLIC_HOST ?? detectLanAddress() ?? "127.0.0.1";
    secure = process.env.WRANGLR_SECURE === "true";
    phoneUrl = `${secure ? "https" : "http"}://${publicHostname}:${pwaPort}`;
    console.log("Local-network-only mode. Phone must be on the same Wi-Fi network as this machine.");
  } else if (tunnelMode === "cloudflare") {
    // Checked above before doing the install and production build.
    if (!cloudflared) throw new Error("cloudflared CLI was not found.");
    console.log("Starting Cloudflare Quick Tunnels…");
    const [pwaTunnel, wsTunnel] = await Promise.all([
      startCloudflareTunnel(cloudflared, "pwa", pwaPort),
      startCloudflareTunnel(cloudflared, "daemon", wsPort),
    ]);
    stopTunnels.push(() => pwaTunnel.process.kill(), () => wsTunnel.process.kill());
    publicHostname = process.env.WRANGLR_PUBLIC_HOST ?? wsTunnel.hostname;
    secure = true;
    phoneUrl = `https://${pwaTunnel.hostname}`;
    console.log(
      "Note: unlike Tailscale, Cloudflare Tunnel routes traffic through Cloudflare's edge, which " +
        "terminates TLS there. See SECURITY.md for the trust trade-off. The tunnel URLs above change " +
        "every time you restart Wranglr in this mode.",
    );
  } else {
    // Checked above before doing the install and production build.
    if (!tailscale) throw new Error("Tailscale CLI was not found.");
    publicHostname = await tailscaleHostname(tailscale);
    secure = true;
    await run([tailscale, "serve", "--bg", "--https=443", `http://127.0.0.1:${pwaPort}`]);
    await run([tailscale, "serve", "--bg", `--https=${publicPort}`, `http://127.0.0.1:${wsPort}`]);
    phoneUrl = `https://${publicHostname}`;
  }

  const bindsLocally = tunnelMode !== "none";
  const serviceEnvironment = {
    ...process.env,
    WRANGLR_TOKEN: token,
    WRANGLR_BIND_HOST: process.env.WRANGLR_BIND_HOST ?? (bindsLocally ? "127.0.0.1" : "0.0.0.0"),
    WRANGLR_PUBLIC_HOST: publicHostname,
    WRANGLR_PUBLIC_PORT: String(publicPort),
    WRANGLR_SECURE: String(secure),
    WRANGLR_WS_PORT: String(wsPort),
    WRANGLR_HOOK_PORT: String(hookPort),
    WRANGLR_POLICY_PATH: policyPath,
    WRANGLR_PWA_HOST: process.env.WRANGLR_PWA_HOST ?? (bindsLocally ? "127.0.0.1" : "0.0.0.0"),
    WRANGLR_PWA_PORT: String(pwaPort),
  };

  console.log(`\nPhone URL: ${phoneUrl}`);
  if (tunnelMode === "none") console.log("Make sure your phone is on the same Wi-Fi network as this machine.");
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
    for (const stopTunnel of stopTunnels) stopTunnel();
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
