/**
 * Background timers: kitchen estimate refresh and notification dispatch.
 *
 * Started by server.js only, never by app.js, so tests that import the app do
 * not get stray timers. Timers are unref'd so they never keep the process alive.
 */

const config = require("../config");
const { refreshEstimates } = require("./kitchenEta");
const { dispatchDue } = require("./notifications");

function startBackgroundJobs({ log = console } = {}) {
  const timers = [];

  const etaMs = config.kitchen.etaRefreshSeconds * 1000;
  if (etaMs > 0) {
    timers.push(
      setInterval(() => {
        refreshEstimates().catch((err) => log.error("Estimate refresh failed:", err.message));
      }, etaMs)
    );
  }

  const notifyMs = config.notify.dispatchSeconds * 1000;
  if (notifyMs > 0) {
    timers.push(
      setInterval(() => {
        dispatchDue().catch((err) => log.error("Notification dispatch failed:", err.message));
      }, notifyMs)
    );
  }

  for (const t of timers) t.unref();
  return () => timers.forEach((t) => clearInterval(t));
}

module.exports = { startBackgroundJobs };
