import { test, expect } from "@playwright/test";

/**
 * Browser smoke test for the student and staff real-time workflows.
 *
 * This is the visual verification the API tests cannot give: a real Chromium
 * rendering the production build, with independent signed-in sessions
 * observing each other over the WebSocket connection.
 *
 * Each test provisions its own student so assertions about order counts are
 * deterministic rather than depending on what earlier tests left behind.
 */

const API = "http://127.0.0.1:5000/api";
const ADMIN = { name: "E2E Admin", email: "e2e.admin@college.edu", password: "adminpass123" };
const OTHER = { name: "E2E Other", email: "e2e.other@college.edu", password: "otherpass123" };

let studentCounter = 0;

/** Register a brand-new student through the API and return their credentials. */
async function createStudent() {
  studentCounter += 1;
  const name = `E2E Student ${studentCounter}`;
  const email = `e2e.s${studentCounter}.${Date.now()}@college.edu`;
  const password = "studentpass123";

  const res = await fetch(`${API}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email, password }),
  });
  if (!res.ok) throw new Error(`student signup failed: ${res.status}`);

  return { name, email, password };
}

async function login(page, who) {
  await page.goto("/");
  await page.getByPlaceholder("Email").fill(who.email);
  await page.getByPlaceholder("Password").fill(who.password);
  await page.getByRole("button", { name: "Login" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(who.name, {
    timeout: 20_000,
  });
}

/** Order card scoped to one specific order. */
const orderCard = (page, id) => page.locator(`[data-order-id="${id}"]`);

/** Add one menu item to the cart and check out. Returns the new order id. */
async function placeOrder(page, itemName) {
  await page
    .getByTestId("food-card")
    .filter({ hasText: itemName })
    .getByTestId("add-to-cart")
    .click();
  await page.getByTestId("checkout").click();

  const card = page.getByTestId("order-card").first();
  await expect(card).toBeVisible();
  const id = await card.getAttribute("data-order-id");
  expect(id).toBeTruthy();
  return id;
}

test.describe("College Canteen — browser smoke test", () => {
  test("menu, cart and checkout render and place a real order", async ({ page }) => {
    const student = await createStudent();
    await login(page, student);

    // The seeded menu is rendered.
    await expect(page.getByTestId("food-card")).toHaveCount(3);
    await expect(
      page.getByTestId("food-card").filter({ hasText: "Masala Dosa" })
    ).toBeVisible();

    // The real-time indicator reports a live connection.
    await expect(page.getByText("Live", { exact: true })).toBeVisible({ timeout: 20_000 });

    // Add two different items; the cart totals them server-consistently.
    await page
      .getByTestId("food-card")
      .filter({ hasText: "Masala Dosa" })
      .getByTestId("add-to-cart")
      .click();
    await page
      .getByTestId("food-card")
      .filter({ hasText: "Filter Coffee" })
      .getByTestId("add-to-cart")
      .click();

    await expect(page.getByText("₹100")).toBeVisible(); // 80 + 20

    await page.getByTestId("checkout").click();

    const card = page.getByTestId("order-card").first();
    await expect(card).toBeVisible();
    await expect(card.getByTestId("order-status")).toHaveText("Pending");
    await expect(card).toContainText("Masala Dosa");
    await expect(card).toContainText("₹100");
  });

  test("a student sees staff status changes live, without reloading", async ({ browser }) => {
    const student = await createStudent();

    // Two fully independent sessions, as two real people would have.
    const studentCtx = await browser.newContext();
    const adminCtx = await browser.newContext();
    const studentPage = await studentCtx.newPage();
    const adminPage = await adminCtx.newPage();

    try {
      await login(studentPage, student);
      const orderId = await placeOrder(studentPage, "Paneer Tikka");
      await expect(orderCard(studentPage, orderId).getByTestId("order-status")).toHaveText(
        "Pending"
      );

      // Admin signs in on a separate browser context.
      await login(adminPage, ADMIN);
      await expect(adminPage.getByText("Live", { exact: true })).toBeVisible({
        timeout: 20_000,
      });

      const adminCard = orderCard(adminPage, orderId);
      await expect(adminCard).toBeVisible();
      await expect(adminCard.getByTestId("admin-order-status")).toHaveText("Pending");
      await expect(adminCard).toContainText(student.email);

      // Admin accepts the order.
      await adminCard.getByTestId("status-Accepted").click();
      await expect(adminCard.getByTestId("admin-order-status")).toHaveText("Accepted");

      // THE LIVE CHECK: this page was never reloaded, yet its status must
      // change because the WebSocket notification triggered a REST re-read.
      await expect(orderCard(studentPage, orderId).getByTestId("order-status")).toHaveText(
        "Accepted",
        { timeout: 25_000 }
      );

      // The audit trail rendered in the student's view.
      await expect(orderCard(studentPage, orderId)).toContainText("Pending → Accepted");

      // The live channel keeps working for further transitions.
      await adminCard.getByTestId("status-Preparing").click();
      await expect(orderCard(studentPage, orderId).getByTestId("order-status")).toHaveText(
        "Preparing",
        { timeout: 25_000 }
      );
    } finally {
      await studentCtx.close();
      await adminCtx.close();
    }
  });

  test("a student cancels their own eligible order and the button disappears", async ({
    browser,
  }) => {
    const student = await createStudent();

    const studentCtx = await browser.newContext();
    const adminCtx = await browser.newContext();
    const studentPage = await studentCtx.newPage();
    const adminPage = await adminCtx.newPage();

    try {
      await login(studentPage, student);
      const orderId = await placeOrder(studentPage, "Filter Coffee");
      const card = orderCard(studentPage, orderId);

      // Cancel is offered only while the order is eligible.
      await expect(card.getByTestId("cancel-order")).toBeVisible();

      // Confirm the dialog before cancelling.
      studentPage.once("dialog", (d) => d.accept());
      await card.getByTestId("cancel-order").click();

      await expect(card.getByTestId("order-status")).toHaveText("Cancelled");
      // No longer eligible, so the control is gone.
      await expect(card.getByTestId("cancel-order")).toHaveCount(0);

      // The staff board sees the cancellation too.
      await login(adminPage, ADMIN);
      await expect(
        orderCard(adminPage, orderId).getByTestId("admin-order-status")
      ).toHaveText("Cancelled", { timeout: 25_000 });
    } finally {
      await studentCtx.close();
      await adminCtx.close();
    }
  });

  test("cancel is refused once preparation has begun", async ({ browser }) => {
    const student = await createStudent();

    const studentCtx = await browser.newContext();
    const adminCtx = await browser.newContext();
    const studentPage = await studentCtx.newPage();
    const adminPage = await adminCtx.newPage();

    try {
      await login(studentPage, student);
      const orderId = await placeOrder(studentPage, "Masala Dosa");
      const card = orderCard(studentPage, orderId);

      // Staff starts preparing.
      await login(adminPage, ADMIN);
      await orderCard(adminPage, orderId).getByTestId("status-Preparing").click();
      await expect(card.getByTestId("order-status")).toHaveText("Preparing", {
        timeout: 25_000,
      });

      // The server-derived eligibility removes the control entirely.
      await expect(card.getByTestId("cancel-order")).toHaveCount(0);

      // The server refuses the student's direct cancellation attempt too.
      // (An ADMIN cancel here would be 400, because that role must give a
      // reason -- which is itself the documented policy.)
      const refused = await studentPage.evaluate(async (id) => {
        const res = await fetch(`http://127.0.0.1:5000/api/orders/${id}/cancel`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${localStorage.getItem("token")}`,
          },
          body: "{}",
        });
        return res.status;
      }, orderId);

      expect(refused).toBe(409);

      // And an admin cancellation without the required reason is refused too.
      const adminNoReason = await adminPage.evaluate(async (id) => {
        const res = await fetch(`http://127.0.0.1:5000/api/orders/${id}/cancel`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${localStorage.getItem("token")}`,
          },
          body: "{}",
        });
        return res.status;
      }, orderId);

      expect(adminNoReason).toBe(400);
    } finally {
      await studentCtx.close();
      await adminCtx.close();
    }
  });

  test("a student never sees another student's orders in the UI", async ({ browser }) => {
    const student = await createStudent();

    const aCtx = await browser.newContext();
    const bCtx = await browser.newContext();
    const aPage = await aCtx.newPage();
    const bPage = await bCtx.newPage();

    try {
      await login(aPage, student);
      await placeOrder(aPage, "Masala Dosa");
      await expect(aPage.getByTestId("order-card")).toHaveCount(1);

      // A different student signs in on a separate context.
      await login(bPage, OTHER);
      await expect(bPage.getByText("You have no orders yet.")).toBeVisible();
      await expect(bPage.getByTestId("order-card")).toHaveCount(0);

      // A new order for A must not surface in B's interface.
      await placeOrder(aPage, "Paneer Tikka");
      await aPage.waitForTimeout(1500);

      await expect(bPage.getByTestId("order-card")).toHaveCount(0);
      await expect(bPage.getByText(student.email)).toHaveCount(0);
    } finally {
      await aCtx.close();
      await bCtx.close();
    }
  });

  test("a session survives a page reload via the stored token", async ({ page }) => {
    const student = await createStudent();
    await login(page, student);
    await page.reload();

    // GET /api/auth/me restores the session; the user is not bounced to login.
    await expect(page.getByRole("heading", { level: 1 })).toContainText(student.name, {
      timeout: 20_000,
    });
    await expect(page.getByRole("button", { name: "Logout" })).toBeVisible();
  });

  test("logout clears the session and returns to the login form", async ({ page }) => {
    const student = await createStudent();
    await login(page, student);
    await page.getByRole("button", { name: "Logout" }).click();

    await expect(page.getByRole("button", { name: "Login" })).toBeVisible();
    await page.reload();
    // The stored token is gone, so the login screen persists.
    await expect(page.getByRole("button", { name: "Login" })).toBeVisible();
  });
});