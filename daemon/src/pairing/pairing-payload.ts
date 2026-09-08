export function buildPairingPayload(hostname: string, port: number, token: string, secure = false): string {
  return JSON.stringify({ hostname, port, token, secure });
}
