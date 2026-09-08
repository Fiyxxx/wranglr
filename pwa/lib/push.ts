import type { PairingInfo } from "./pairing";
import { apiUrl } from "./pairing";

export function urlBase64ToArrayBuffer(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const bytes = new Uint8Array(rawData.length);
  for (let index = 0; index < rawData.length; index++) {
    bytes[index] = rawData.charCodeAt(index);
  }
  return bytes.buffer;
}

export async function registerPush(pairing: PairingInfo): Promise<"granted" | "denied" | "unsupported"> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return "unsupported";
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "denied";

  try {
    const registration = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;

    const keyResponse = await fetch(apiUrl(pairing, "/vapid-public-key"));
    if (!keyResponse.ok) throw new Error("Could not load the push key");
    const { publicKey } = (await keyResponse.json()) as { publicKey: string };

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToArrayBuffer(publicKey),
    });

    const response = await fetch(apiUrl(pairing, "/push-subscribe"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(subscription.toJSON()),
    });
    if (!response.ok) throw new Error("Could not save the push subscription");

    return "granted";
  } catch {
    return "denied";
  }
}
