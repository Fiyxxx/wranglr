import { z } from "zod";

export interface PairingInfo {
  hostname: string;
  port: number;
  token: string;
  secure: boolean;
}

const PairingSchema = z.object({
  hostname: z.string(),
  port: z.number(),
  token: z.string(),
  secure: z.boolean().default(false),
});

const STORAGE_KEY = "wranglr.pairing";

export function savePairing(info: PairingInfo): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(info));
}

export function loadPairing(): PairingInfo | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = PairingSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function clearPairing(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function parsePairingPayload(text: string): PairingInfo | null {
  try {
    const parsed = PairingSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function wsUrl(info: PairingInfo): string {
  const protocol = info.secure ? "wss" : "ws";
  return `${protocol}://${info.hostname}:${info.port}/?token=${encodeURIComponent(info.token)}`;
}

export function apiUrl(info: PairingInfo, path: string): string {
  const protocol = info.secure ? "https" : "http";
  return `${protocol}://${info.hostname}:${info.port}${path}?token=${encodeURIComponent(info.token)}`;
}
