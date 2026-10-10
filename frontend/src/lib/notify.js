/**
 * Notification preferences, as the student dashboard applies them.
 *
 * The server stores `notificationPrefs` on the user. These helpers decide what
 * the in-app pickup alert does with them. Email and push delivery are not built,
 * so `promotions` has no effect yet: no promotional messages are sent.
 */

export const DEFAULT_NOTIFICATION_PREFS = Object.freeze({
  orderUpdates: true,
  promotions: false,
  sound: true,
});

/** Keep only known keys with boolean values; anything else falls back to the default. */
export function normalizePrefs(raw) {
  const out = { ...DEFAULT_NOTIFICATION_PREFS };
  for (const key of Object.keys(DEFAULT_NOTIFICATION_PREFS)) {
    if (raw && typeof raw[key] === "boolean") out[key] = raw[key];
  }
  return out;
}

/** Whether a "ready for pickup" alert is raised at all. */
export function shouldRaiseReadyAlert(prefs) {
  return prefs.orderUpdates !== false;
}

/** Whether the pickup alert plays a sound. */
export function shouldPlaySound(prefs) {
  return prefs.sound !== false;
}

/**
 * Short two-tone chime. Silent when Web Audio is unavailable or the browser
 * blocks playback before a user gesture; the visible alert still shows.
 */
export function playPickupTone() {
  try {
    const Ctx = typeof window !== "undefined" ? window.AudioContext || window.webkitAudioContext : null;
    if (!Ctx) return;
    const ctx = new Ctx();
    const beep = (frequency, startAt) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + startAt);
      gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + startAt + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + startAt + 0.25);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + startAt);
      osc.stop(ctx.currentTime + startAt + 0.3);
    };
    beep(880, 0);
    beep(1175, 0.3);
    setTimeout(() => ctx.close().catch(() => {}), 1000);
  } catch {
    // No audio device or playback blocked: the visual alert is enough.
  }
}
