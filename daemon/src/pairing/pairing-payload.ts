export function buildPairingPayload(hostname: string, port: number, token: string): string {
  return JSON.stringify({ hostname, port, token });
}
