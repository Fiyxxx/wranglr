import { z } from "zod";

export interface PairingInfo {
  hostname: string;
  port: number;
  token: string;
}

const PairingSchema = z.object({
  hostname: z.string(),
  port: z.number(),
  token: z.string(),
});

const STORAGE_KEY = "wranglr.pairing";

export function savePairing(info: PairingInfo): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(info));
}

export function loadPairing(): PairingInfo | null {
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
  return `ws://${info.hostname}:${info.port}/?token=${info.token}`;
}
