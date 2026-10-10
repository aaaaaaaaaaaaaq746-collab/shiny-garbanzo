import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_NOTIFICATION_PREFS,
  normalizePrefs,
  shouldPlaySound,
  shouldRaiseReadyAlert,
} from "../../src/lib/notify.js";
import { STATUS_LABEL, statusLabel } from "../../src/orderStatus.js";

test("normalizePrefs keeps boolean values and falls back to defaults for anything else", () => {
  assert.deepEqual(normalizePrefs(undefined), DEFAULT_NOTIFICATION_PREFS);
  assert.deepEqual(normalizePrefs({ sound: false }), { ...DEFAULT_NOTIFICATION_PREFS, sound: false });
  assert.deepEqual(normalizePrefs({ sound: "no", orderUpdates: 0, extra: true }), DEFAULT_NOTIFICATION_PREFS);
});

test("the ready alert is raised unless order updates are turned off", () => {
  assert.equal(shouldRaiseReadyAlert({ orderUpdates: true }), true);
  assert.equal(shouldRaiseReadyAlert({ orderUpdates: false }), false);
  assert.equal(shouldRaiseReadyAlert({}), true, "a missing preference does not silence the alert");
});

test("the pickup sound follows the sound preference", () => {
  assert.equal(shouldPlaySound({ sound: true }), true);
  assert.equal(shouldPlaySound({ sound: false }), false);
  assert.equal(shouldPlaySound({}), true);
});

test("students see the expanded status names; stored values are unchanged", () => {
  assert.equal(statusLabel("Pending"), "Pending confirmation");
  assert.equal(statusLabel("Ready"), "Ready for pickup");
  assert.equal(statusLabel("Accepted"), "Accepted");
  assert.equal(statusLabel("Cancelled"), "Cancelled");
  assert.equal(statusLabel("Rejected"), "Rejected");
  assert.equal(statusLabel("Mystery"), "Mystery", "an unknown status is shown as it is");
  assert.deepEqual(Object.keys(STATUS_LABEL).sort(), ["Accepted", "Cancelled", "Completed", "Pending", "Preparing", "Ready", "Rejected"]);
});
