import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * Captures screenshots of the rendered UI so the real visual result can be
 * reviewed, rather than only asserting on locators.
 */

const API = "http://127.0.0.1:5000/api";
const OUT = path.join(process.cwd(), "e2e", "screenshots");

const ADMIN = { name: "E2E Admin", email: "e2e.admin@college.edu", password: "adminpass123" };
const STUDENT = {
  name: "Screenshot Student",
  email: `e2e.shots.${Date.now()}@college.edu`,
  password: "studentpass123",
};

async function seedOrder() {
  const signup = await fetch(`${API}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(STUDENT),
  });
  if (!signup.ok) throw new Error(`signup failed: ${signup.status}`);

  const login = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: STUDENT.email, password: STUDENT.password }),
  });
  const { token } = await login.json();

  const menu = await (await fetch(`${API}/food`)).json();
  const adminLogin = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
  });
  const { token: adminToken } = await adminLogin.json();

  const ids = [];
  for (const name of ["Masala Dosa", "Paneer Tikka"]) {
    const item = menu.find((m) => m.name === name);
    const res = await fetch(`${API}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ items: [{ food: item._id, quantity: 2 }] }),
    });
    ids.push((await res.json())._id);
  }

  // Drive the first order forward so the admin board shows a live status.
  await fetch(`${API}/orders/${ids[0]}/status`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ status: "Preparing" }),
  });

  return ids;
}

async function login(page, who) {
  await page.goto("/");
  await page.getByPlaceholder("Email").fill(who.email);
  await page.getByPlaceholder("Password").fill(who.password);
  await page.getByRole("button", { name: "Login" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Welcome", {
    timeout: 20_000,
  });
}

test("capture student and admin interfaces", async ({ page }) => {
  fs.mkdirSync(OUT, { recursive: true });
  await seedOrder();

  // --- Student ---
  await login(page, STUDENT);
  await expect(page.getByText("Live", { exact: true })).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, "student-dashboard.png"), fullPage: true });

  // Student with an item in the cart.
  await page
    .getByTestId("food-card")
    .filter({ hasText: "Filter Coffee" })
    .getByTestId("add-to-cart")
    .click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, "student-cart.png"), fullPage: true });

  // --- Admin ---
  const adminPage = await page.context().browser().newContext().then((c) => c.newPage());
  await login(adminPage, ADMIN);
  await expect(adminPage.getByText("Live", { exact: true })).toBeVisible({ timeout: 20_000 });
  await adminPage.waitForTimeout(800);
  await adminPage.screenshot({ path: path.join(OUT, "admin-dashboard.png"), fullPage: true });

  // --- Login screen ---
  const anon = await page.context().browser().newContext().then((c) => c.newPage());
  await anon.goto("/");
  await anon.waitForTimeout(500);
  await anon.screenshot({ path: path.join(OUT, "login.png") });

  test.info().annotations.push({ type: "screenshots", description: OUT });
});