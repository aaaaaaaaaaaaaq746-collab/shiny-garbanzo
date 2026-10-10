/**
 * Browser push subscription for order notifications.
 *
 * Enabling push asks the browser for permission, registers the service worker
 * (public/sw.js), subscribes with the server's public key, and sends the
 * subscription to the server. Disabling removes it from both sides. Nothing
 * here runs unless the student asks for it.
 */

export function pushSupported() {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** Convert the URL-safe base64 VAPID key into the bytes the browser expects. */
export function urlBase64ToUint8Array(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
}

/**
 * Subscribe this browser. Throws with a student-readable message when the
 * browser cannot, the server is not configured, or permission is refused.
 */
export async function enablePush(api) {
  if (!pushSupported()) {
    throw new Error("This browser does not support push notifications.");
  }
  const keyRes = await api.get("/notifications/push-key");
  const publicKey = keyRes.data?.publicKey;
  if (!publicKey) {
    throw new Error("Push notifications are not set up on this canteen's server yet.");
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notification permission was not granted in your browser.");
  }

  const registration = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ||
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));

  const json = subscription.toJSON();
  await api.post("/notifications/push-subscriptions", { endpoint: json.endpoint, keys: json.keys });
  return true;
}

/** Remove this browser's subscription from the browser and the server. */
export async function disablePush(api) {
  if (!pushSupported()) return;
  const registration = await navigator.serviceWorker.getRegistration("/sw.js");
  const subscription = registration ? await registration.pushManager.getSubscription() : null;
  if (!subscription) return;
  await api.delete("/notifications/push-subscriptions", { params: { endpoint: subscription.endpoint } });
  await subscription.unsubscribe();
}
