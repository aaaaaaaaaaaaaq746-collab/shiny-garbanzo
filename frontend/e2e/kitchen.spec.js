import { test, expect } from "@playwright/test";

/**
 * Browser verification for the Kitchen Display System, the student progress
 * timeline, the ready-for-pickup notification, and the admin board filters.
 *
 * Runs against the production build and a live backend with the real-time
 * layer, so the two screens are observed interacting over the WebSocket.
 */

const API = "http://127.0.0.1:5000/api";
const ADMIN = { name: "E2E Admin", email: "e2e.admin@college.edu", password: "adminpass123" };
const STAFF = { name: "E2E Kitchen", email: "e2e.kitchen@college.edu", password: "kitchenpass123" };

let n = 0;

async function createStudent() {
  n += 1;
  const name = `KDS Student ${n}`;
  const email = `e2e.kds${n}.${Date.now()}@college.edu`;
  const password = "studentpass123";
  const res = await fetch(`${API}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email, password }),
  });
  if (!res.ok) throw new Error(`signup failed: ${res.status}`);
  return { name, email, password };
}

async function ensureStaff() {
  // Provisioned once; reuse if it already exists.
  const login = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: STAFF.email, password: STAFF.password }),
  });
  if (login.ok) return;
  throw new Error(`staff account missing: ${login.status}`);
}

async function signIn(page, who) {
  await page.goto("/");
  await page.getByPlaceholder("Email").fill(who.email);
  await page.getByPlaceholder("Password").fill(who.password);
  await page.getByRole("button", { name: "Login" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(who.name, {
    timeout: 20_000,
  });
}

const card = (page, id) => page.locator(`[data-order-id="${id}"]`);

test.beforeAll(async () => {
  await ensureStaff();
});

test.describe("Kitchen Display System", () => {
  test("a staff member opens the kitchen display and sees the live queue", async ({
    browser,
  }) => {
    const student = await createStudent();
    const ctx = await browser.newContext();
    const staffPage = await ctx.newPage();

    try {
      await signIn(staffPage, STAFF);
      await staffPage.getByTestId("open-kitchen").click();

      await expect(staffPage.getByRole("heading", { name: /Kitchen Display/i })).toBeVisible();
      await expect(staffPage.getByTestId("kitchen-live")).toContainText("Live", {
        timeout: 20_000,
      });

      // An order placed by a student appears without any page interaction.
      const sCtx = await browser.newContext();
      const sPage = await sCtx.newPage();
      await signIn(sPage, student);
      await sPage
        .getByTestId("food-card")
        .filter({ hasText: "Paneer Tikka" })
        .getByTestId("add-to-cart")
        .click();
      await sPage.getByTestId("checkout").click();
      const orderId = await sPage.getByTestId("order-card").first().getAttribute("data-order-id");

      const kCard = card(staffPage, orderId);
      await expect(kCard).toBeVisible({ timeout: 25_000 });
      await expect(kCard.getByTestId("kitchen-order-status")).toHaveText("Pending");
      await expect(kCard).toContainText(student.email);
      await sCtx.close();
    } finally {
      await ctx.close();
    }
  });

  test("the board shows quantities, waiting time and special instructions", async ({
    browser,
  }) => {
    const student = await createStudent();
    const ctx = await browser.newContext();
    const staffPage = await ctx.newPage();

    try {
      await signIn(staffPage, STAFF);
      await staffPage.getByTestId("open-kitchen").click();

      const sCtx = await browser.newContext();
      const sPage = await sCtx.newPage();
      await signIn(sPage, student);

      // Place an order carrying instructions through the API, since the
      // student interface has no notes field yet.
      const login = await fetch(`${API}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: student.email, password: student.password }),
      });
      const { token } = await login.json();
      const menu = await (await fetch(`${API}/food`)).json();
      const item = menu.find((m) => m.name === "Filter Coffee");
      const created = await (
        await fetch(`${API}/orders`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            items: [{ food: item._id, quantity: 3 }],
            notes: "Extra sugar, no milk",
            pickupSlot: "13:00",
          }),
        })
      ).json();

      const kCard = card(staffPage, created._id);
      await expect(kCard).toBeVisible({ timeout: 25_000 });

      // Quantity and price line.
      await expect(kCard.getByTestId("kitchen-item").first()).toContainText("3×");
      await expect(kCard.getByTestId("kitchen-item").first()).toContainText("Filter Coffee");

      // Special instructions.
      await expect(kCard.getByTestId("kitchen-notes")).toContainText("Extra sugar, no milk");

      // Pickup slot.
      await expect(kCard).toContainText("13:00");

      // A live elapsed timer (m:ss).
      const wait = kCard.getByTestId("kitchen-wait");
      await expect(wait).toBeVisible();
      await expect(wait).toHaveText(/^\d+:\d{2}$/);
      await sCtx.close();
    } finally {
      await ctx.close();
    }
  });

  test("a kitchen action drives the order and the student's screen updates", async ({
    browser,
  }) => {
    const student = await createStudent();
    const sCtx = await browser.newContext();
    const kCtx = await browser.newContext();
    const sPage = await sCtx.newPage();
    const kPage = await kCtx.newPage();

    try {
      await signIn(sPage, student);
      await sPage
        .getByTestId("food-card")
        .filter({ hasText: "Masala Dosa" })
        .getByTestId("add-to-cart")
        .click();
      await sPage.getByTestId("checkout").click();
      const orderId = await sPage.getByTestId("order-card").first().getAttribute("data-order-id");

      await signIn(kPage, STAFF);
      await kPage.getByTestId("open-kitchen").click();
      const kCard = card(kPage, orderId);
      await expect(kCard).toBeVisible({ timeout: 25_000 });

      // Accept from the kitchen board.
      await kCard.getByTestId("kitchen-action-Accepted").click();
      await expect(kCard.getByTestId("kitchen-order-status")).toHaveText("Accepted");

      // The student's timeline advances live, with no reload.
      const timeline = sPage.getByTestId("order-timeline").first();
      await expect(
        sPage.locator(`[data-order-id="${orderId}"]`).getByTestId("timeline-step-Accepted")
      ).toHaveAttribute("data-state", "current", { timeout: 25_000 });
      await expect(timeline).toBeVisible();

      // Completing removes it from the live board.
      await kCard.getByTestId("kitchen-action-Completed").click();
      await expect(kCard).toHaveCount(0, { timeout: 25_000 });
    } finally {
      await sCtx.close();
      await kCtx.close();
    }
  });

  test("the board offers only transitions the lifecycle permits", async ({ browser }) => {
    const student = await createStudent();
    const ctx = await browser.newContext();
    const kPage = await ctx.newPage();

    try {
      await signIn(kPage, STAFF);
      await kPage.getByTestId("open-kitchen").click();

      const sCtx = await browser.newContext();
      const sPage = await sCtx.newPage();
      await signIn(sPage, student);
      await sPage
        .getByTestId("food-card")
        .filter({ hasText: "Filter Coffee" })
        .getByTestId("add-to-cart")
        .click();
      await sPage.getByTestId("checkout").click();
      const orderId = await sPage.getByTestId("order-card").first().getAttribute("data-order-id");

      const kCard = card(kPage, orderId);
      await expect(kCard).toBeVisible({ timeout: 25_000 });

      // From Pending a staff member cannot reject.
      await expect(kCard.getByTestId("kitchen-action-Rejected")).toHaveCount(0);
      await expect(kCard.getByTestId("kitchen-action-Accepted")).toBeVisible();

      // Once preparing, cancel is no longer offered to staff.
      await kCard.getByTestId("kitchen-action-Preparing").click();
      await expect(kCard.getByTestId("kitchen-order-status")).toHaveText("Preparing");
      await expect(kCard.getByTestId("kitchen-action-Cancelled")).toHaveCount(0);
      await expect(kCard.getByTestId("kitchen-action-Ready")).toBeVisible();

      await sCtx.close();
    } finally {
      await ctx.close();
    }
  });

  test("a student cannot open the kitchen display", async ({ browser }) => {
    const student = await createStudent();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      await signIn(page, student);
      // No kitchen entry point exists for students.
      await expect(page.getByTestId("open-kitchen")).toHaveCount(0);
      // And the feed itself is refused.
      const status = await page.evaluate(async () => {
        const res = await fetch("http://127.0.0.1:5000/api/orders/kitchen", {
          headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
        });
        return res.status;
      });
      expect(status).toBe(403);
    } finally {
      await ctx.close();
    }
  });

;
});

test.describe("Student tracking", () => {
  test("the progress timeline reflects each stage", async ({ browser }) => {
    const student = await createStudent();
    const sCtx = await browser.newContext();
    const aCtx = await browser.newContext();
    const sPage = await sCtx.newPage();
    const aPage = await aCtx.newPage();

    try {
      await signIn(sPage, student);
      await sPage
        .getByTestId("food-card")
        .filter({ hasText: "Paneer Tikka" })
        .getByTestId("add-to-cart")
        .click();
      await sPage.getByTestId("checkout").click();
      const orderId = await sPage.getByTestId("order-card").first().getAttribute("data-order-id");
      const timeline = sPage.locator(`[data-order-id="${orderId}"]`);

      // Pending is current; later steps are upcoming.
      await expect(timeline.getByTestId("timeline-step-Pending")).toHaveAttribute(
        "data-state",
        "current"
      );
      await expect(timeline.getByTestId("timeline-step-Ready")).toHaveAttribute(
        "data-state",
        "upcoming"
      );

      await signIn(aPage, ADMIN);
      const adminCard = aPage.locator(`[data-order-id="${orderId}"]`);
      await adminCard.getByTestId("status-Accepted").click();
      await expect(timeline.getByTestId("timeline-step-Accepted")).toHaveAttribute(
        "data-state",
        "current",
        { timeout: 25_000 }
      );
      await expect(timeline.getByTestId("timeline-step-Pending")).toHaveAttribute(
        "data-state",
        "done"
      );
    } finally {
      await sCtx.close();
      await aCtx.close();
    }
  });

  test("a ready-for-pickup notification appears when the order reaches Ready", async ({
    browser,
  }) => {
    const student = await createStudent();
    const sCtx = await browser.newContext();
    const aCtx = await browser.newContext();
    const sPage = await sCtx.newPage();
    const aPage = await aCtx.newPage();

    try {
      await signIn(sPage, student);
      await sPage
        .getByTestId("food-card")
        .filter({ hasText: "Masala Dosa" })
        .getByTestId("add-to-cart")
        .click();
      await sPage.getByTestId("checkout").click();
      const orderId = await sPage.getByTestId("order-card").first().getAttribute("data-order-id");

      // No pickup alert while the order is only Pending.
      await expect(sPage.getByTestId("ready-alert")).toHaveCount(0);

      await signIn(aPage, ADMIN);
      const adminCard = aPage.locator(`[data-order-id="${orderId}"]`);
      await adminCard.getByTestId("status-Preparing").click();
      await adminCard.getByTestId("status-Ready").click();

      // The notification arrives on the untouched student page.
      const alert = sPage.getByTestId("ready-alert");
      await expect(alert).toBeVisible({ timeout: 25_000 });
      await expect(alert).toContainText("ready for pickup");

      // And it is dismissible.
      await alert.getByRole("button", { name: /Dismiss/i }).click();
      await expect(sPage.getByTestId("ready-alert")).toHaveCount(0);
    } finally {
      await sCtx.close();
      await aCtx.close();
    }
  });
});

test.describe("Admin order board", () => {
  test("status filters narrow the board without a page refresh", async ({ browser }) => {
    const student = await createStudent();
    const sCtx = await browser.newContext();
    const aCtx = await browser.newContext();
    const sPage = await sCtx.newPage();
    const aPage = await aCtx.newPage();

    try {
      await signIn(sPage, student);
      await sPage
        .getByTestId("food-card")
        .filter({ hasText: "Filter Coffee" })
        .getByTestId("add-to-cart")
        .click();
      await sPage.getByTestId("checkout").click();
      const orderId = await sPage.getByTestId("order-card").first().getAttribute("data-order-id");

      await signIn(aPage, ADMIN);
      await expect(aPage.locator(`[data-order-id="${orderId}"]`)).toBeVisible({
        timeout: 25_000,
      });

      // Filter to Preparing: this order is Pending, so it must disappear.
      await aPage.getByTestId("filter-Preparing").click();
      await expect(aPage.locator(`[data-order-id="${orderId}"]`)).toHaveCount(0);

      // Back to Pending: it returns, still without a reload.
      await aPage.getByTestId("filter-Pending").click();
      await expect(aPage.locator(`[data-order-id="${orderId}"]`)).toBeVisible();

      // Filter counts reflect reality.
      await expect(aPage.getByTestId("filter-Pending")).toContainText("Pending (");
      await expect(aPage.getByTestId("filter-Completed")).toContainText("Completed (");
    } finally {
      await sCtx.close();
      await aCtx.close();
    }
  });

  test("a new order raises an alert on the open board", async ({ browser }) => {
    const studentA = await createStudent();
    const studentB = await createStudent();
    const aCtx = await browser.newContext();
    const bCtx = await browser.newContext();
    const aPage = await aCtx.newPage();
    const bPage = await bCtx.newPage();

    try {
      // Admin board open and already aware of existing orders.
      await signIn(aPage, ADMIN);
      await expect(aPage.getByTestId("admin-live")).toContainText("Live", { timeout: 20_000 });

      // A different student then places an order.
      await signIn(bPage, studentB);
      await bPage
        .getByTestId("food-card")
        .filter({ hasText: "Paneer Tikka" })
        .getByTestId("add-to-cart")
        .click();
      await bPage.getByTestId("checkout").click();

      // The alert strip appears on the admin board without a reload.
      await expect(aPage.getByTestId("new-order-alert")).toBeVisible({ timeout: 25_000 });
      await expect(aPage.getByTestId("new-order-alert")).toContainText("new order");

      await aPage.getByTestId("new-order-alert").getByText("Dismiss").click();
      await expect(aPage.getByTestId("new-order-alert")).toHaveCount(0);
    } finally {
      await aCtx.close();
      await bCtx.close();
    }
  });

test("the admin board re-pulls authoritative state on demand", async ({ browser }) => {
    const student = await createStudent();
    const aCtx = await browser.newContext();
    const sCtx = await browser.newContext();
    const aPage = await aCtx.newPage();
    const sPage = await sCtx.newPage();

    try {
      await signIn(aPage, ADMIN);
      await expect(aPage.getByTestId("admin-live")).toContainText("Live", { timeout: 20_000 });

      await signIn(sPage, student);
      await sPage
        .getByTestId("food-card")
        .filter({ hasText: "Masala Dosa" })
        .getByTestId("add-to-cart")
        .click();
      await sPage.getByTestId("checkout").click();
      const orderId = await sPage.getByTestId("order-card").first().getAttribute("data-order-id");

      // Arrives live.
      await expect(aPage.locator(`[data-order-id="${orderId}"]`)).toBeVisible({
        timeout: 25_000,
      });
      const countBefore = await aPage.getByTestId("admin-order-card").count();

      // Refreshing re-reads the database and must not duplicate anything.
      await aPage.getByTestId("admin-refresh").click();
      await aPage.waitForTimeout(1000);
      await expect(aPage.locator(`[data-order-id="${orderId}"]`)).toBeVisible();
      await expect(aPage.getByTestId("admin-order-card")).toHaveCount(countBefore);

      // Status changes made through the board still propagate to the student.
      await aPage
        .locator(`[data-order-id="${orderId}"]`)
        .getByTestId("status-Accepted")
        .click();
      await expect(
        aPage.locator(`[data-order-id="${orderId}"]`).getByTestId("admin-order-status")
      ).toHaveText("Accepted");
      await expect(
        sPage.locator(`[data-order-id="${orderId}"]`).getByTestId("order-status")
      ).toHaveText("Accepted", { timeout: 25_000 });

      // Filters survive a refresh.
      await aPage.getByTestId("filter-Preparing").click();
      await expect(aPage.locator(`[data-order-id="${orderId}"]`)).toHaveCount(0);
      await aPage.getByTestId("admin-refresh").click();
      await aPage.waitForTimeout(800);
      await expect(aPage.getByTestId("filter-Preparing")).toHaveAttribute(
        "aria-pressed",
        "true"
      );
    } finally {
      await aCtx.close();
      await sCtx.close();
    }
  });
});
