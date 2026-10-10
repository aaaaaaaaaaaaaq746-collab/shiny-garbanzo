import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/** Captures the kitchen display and the updated student/admin interfaces. */

const API = "http://127.0.0.1:5000/api";
const OUT = path.join(process.cwd(), "e2e", "screenshots");

const ADMIN = { name: "E2E Admin", email: "e2e.admin@college.edu", password: "adminpass123" };
const STAFF = { name: "E2E Kitchen", email: "e2e.kitchen@college.edu", password: "kitchenpass123" };

async function seed() {
  const student = {
    name: "KDS Screenshot",
    email: `e2e.kdsshot.${Date.now()}@college.edu`,
    password: "studentpass123",
  };
  await fetch(`${API}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(student),
  });

  const login = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: student.email, password: student.password }),
  });
  const { token } = await login.json();

  const adminLogin = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
  });
  const { token: adminToken } = await adminLogin.json();

  const menu = await (await fetch(`${API}/food`)).json();
  const ids = [];

  // Three orders in different states so the board shows real variety.
  const specs = [
    { item: "Paneer Tikka", qty: 2, notes: "Extra chutney", slot: "12:30", to: "Accepted" },
    { item: "Masala Dosa", qty: 3, notes: null, slot: "12:45", to: "Preparing" },
    { item: "Filter Coffee", qty: 1, notes: "No sugar", slot: null, to: null },
  ];

  for (const spec of specs) {
    const food = menu.find((m) => m.name === spec.item);
    const body = { items: [{ food: food._id, quantity: spec.qty }] };
    if (spec.notes) body.notes = spec.notes;
    if (spec.slot) body.pickupSlot = spec.slot;

    const created = await (
      await fetch(`${API}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      })
    ).json();
    ids.push(created._id);

    if (spec.to) {
      await fetch(`${API}/orders/${created._id}/status`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ status: spec.to }),
      });
    }
  }

  return { student, ids };
}

async function signIn(page, who) {
  await page.goto("/");
  await page.getByPlaceholder("Email").fill(who.email);
  await page.getByPlaceholder("Password").fill(who.password);
  await page.getByRole("button", { name: "Login" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Welcome", {
    timeout: 20_000,
  });
}

test("capture kitchen display and student tracking", async ({ browser }) => {
  fs.mkdirSync(OUT, { recursive: true });
  const { student } = await seed();

  const sCtx = await browser.newContext();
  const kCtx = await browser.newContext();
  const sPage = await sCtx.newPage();
  const kPage = await kCtx.newPage();

  try {
    // --- Kitchen display ---
    await signIn(kPage, STAFF);
    await kPage.getByTestId("open-kitchen").click();
    await expect(kPage.getByTestId("kitchen-order")).not.toHaveCount(0, { timeout: 20_000 });
    await kPage.waitForTimeout(1200); // let the timer tick a couple of times
    await kPage.screenshot({ path: path.join(OUT, "kitchen-display.png"), fullPage: true });

    // --- Student tracking with timeline ---
    await signIn(sPage, student);
    await expect(sPage.getByTestId("order-timeline").first()).toBeVisible();
    await sPage.waitForTimeout(600);
    await sPage.screenshot({ path: path.join(OUT, "student-tracking.png"), fullPage: true });

    // --- Admin board with filters (fresh context: avoids a stale staff session) ---
    const aCtx = await browser.newContext();
    const aPage = await aCtx.newPage();
    await signIn(aPage, ADMIN);
    await expect(aPage.getByTestId("status-filters")).toBeVisible();
    await aPage.waitForTimeout(600);
    await aPage.screenshot({ path: path.join(OUT, "admin-board.png"), fullPage: true });
    await aCtx.close();
  } finally {
    await sCtx.close();
    await kCtx.close();
  }
});