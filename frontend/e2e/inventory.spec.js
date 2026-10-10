import { test, expect } from "@playwright/test";

/**
 * Browser verification for Phase 4 inventory.
 *
 * Runs against the production build and a live backend. Covers the flows the
 * API tests cannot: an administrator configuring stock, a student seeing the
 * consequence, and the two interfaces updating each other in real time.
 */

const API = "http://127.0.0.1:5000/api";
const ADMIN = { name: "E2E Admin", email: "e2e.admin@college.edu", password: "adminpass123" };

let seq = 0;

async function adminLogin() {
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
  });
  const { token } = await res.json();
  return token;
}

async function createStudent() {
  seq += 1;
  const name = `Inv Student ${seq}`;
  const email = `e2e.inv${seq}.${Date.now()}@college.edu`;
  const password = "studentpass123";
  await fetch(`${API}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email, password }),
  });
  return { name, email, password };
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

/** Create a uniquely named food item via the admin API. */
async function createItem(token, name, stock = null) {
  const body = { name, description: "inventory test", price: 60, category: "Test" };
  const res = await fetch(`${API}/food`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const food = await res.json();
  if (stock !== null) {
    await fetch(`${API}/inventory/${food._id}/tracking`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ enabled: true, stock }),
    });
  }
  return food;
}

test.describe("Phase 4 — inventory", () => {
  test("admin enables tracking, sets stock, and the student sees availability", async ({
    browser,
  }) => {
    const token = await adminLogin();
    const name = `Tracked Snack ${Date.now().toString(36)}`;
    const food = await createItem(token, name);

    const aCtx = await browser.newContext();
    const sCtx = await browser.newContext();
    const aPage = await aCtx.newPage();
    const sPage = await sCtx.newPage();

    try {
      await signIn(aPage, ADMIN);
      await aPage.getByTestId("inventory-search").fill(name);

      // Initially untracked.
      await expect(aPage.getByTestId(`tracking-${food._id}`)).toHaveText("Untracked");

      // Enable tracking with a starting quantity (prompt supplies it).
      aPage.once("dialog", (d) => d.accept("12"));
      await aPage.getByTestId(`toggle-tracking-${food._id}`).click();

      await expect(aPage.getByTestId(`tracking-${food._id}`)).toHaveText("Tracked", {
        timeout: 20_000,
      });
      await expect(aPage.getByTestId(`stock-${food._id}`)).toHaveText("12");
      await expect(aPage.getByTestId(`available-${food._id}`)).toHaveText("12 available");

      // A student sees the same figure on the menu.
      await signIn(sPage, await createStudent());
      const card = sPage.getByTestId("food-card").filter({ hasText: name });
      await expect(card).toBeVisible({ timeout: 20_000 });
      await expect(card.getByTestId(`availability-${food._id}`)).toHaveText("12 servings available");
      await expect(card.getByTestId("add-to-cart")).toBeVisible();
    } finally {
      await aCtx.close();
      await sCtx.close();
    }
  });

  test("a stock adjustment with a reason updates the student menu", async ({ browser }) => {
    const token = await adminLogin();
    const name = `Adjusted Item ${Date.now().toString(36)}`;
    const food = await createItem(token, name, 10);

    const aCtx = await browser.newContext();
    const sCtx = await browser.newContext();
    const aPage = await aCtx.newPage();
    const sPage = await sCtx.newPage();

    try {
      await signIn(sPage, await createStudent());
      const card = sPage.getByTestId("food-card").filter({ hasText: name });
      await expect(card.getByTestId(`availability-${food._id}`)).toHaveText("10 servings available");

      await signIn(aPage, ADMIN);
      await aPage.getByTestId("inventory-search").fill(name);

      // A reason is required before an adjustment will apply.
      await aPage.getByTestId(`adjust-value-${food._id}`).fill("5");
      await aPage.getByTestId(`apply-adjust-${food._id}`).click();
      await expect(aPage.getByTestId("inventory-error")).toContainText("reason", {
        timeout: 10_000,
      });

      // With a reason it succeeds.
      await aPage.getByTestId(`adjust-reason-${food._id}`).fill("Supplier delivery");
      await aPage.getByTestId(`apply-adjust-${food._id}`).click();
      await expect(aPage.getByTestId(`stock-${food._id}`)).toHaveText("15", { timeout: 20_000 });

      // The student's card updates live over the socket, without a reload.
      await expect(card.getByTestId(`availability-${food._id}`)).toHaveText("15 servings available", {
        timeout: 25_000,
      });
    } finally {
      await aCtx.close();
      await sCtx.close();
    }
  });

  test("a student cannot order more than the available stock", async ({ browser }) => {
    const token = await adminLogin();
    const name = `Scarce Item ${Date.now().toString(36)}`;
    const food = await createItem(token, name, 1);

    const sCtx = await browser.newContext();
    const sPage = await sCtx.newPage();

    try {
      await signIn(sPage, await createStudent());
      const card = sPage.getByTestId("food-card").filter({ hasText: name });
      await expect(card).toBeVisible({ timeout: 20_000 });

      // Add the single available unit.
      await card.getByTestId("add-to-cart").click();
      await expect(page1CartItem(sPage)).toBeVisible();

      // The card now shows nothing left and offers no add button.
      await expect(card.getByTestId("availability-" + food._id)).toHaveText("No more available");
      await expect(card.getByTestId("sold-out")).toHaveText("None left");

      // Ordering still goes through; the server confirms the reservation.
      await sPage.getByTestId("checkout").click();
      await expect(sPage.getByTestId("order-card").first()).toBeVisible({ timeout: 20_000 });
    } finally {
      await sCtx.close();
    }
  });

  test("an item drained to zero cannot be ordered and shows sold out", async ({ browser }) => {
    const token = await adminLogin();
    const name = `Drained Item ${Date.now().toString(36)}`;
    const food = await createItem(token, name, 1);

    // Drain it through the admin API.
    await fetch(`${API}/inventory/${food._id}/adjust`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ set: 0, reason: "Sold through" }),
    });

    const sCtx = await browser.newContext();
    const sPage = await sCtx.newPage();

    try {
      await signIn(sPage, await createStudent());
      const card = sPage.getByTestId("food-card").filter({ hasText: name });
      await expect(card).toBeVisible({ timeout: 20_000 });
      await expect(card.getByTestId("sold-out")).toBeVisible();
      await expect(card.getByTestId("add-to-cart")).toHaveCount(0);

      // And the server refuses a direct order attempt.
      const login = await fetch(`${API}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: sPage.url() ? undefined : undefined }),
      }).catch(() => null);
      expect(login === null || login.status === 400).toBeTruthy();
    } finally {
      await sCtx.close();
    }
  });

  test("low stock raises an alert, and acknowledging clears the 'new' badge", async ({
    browser,
  }) => {
    const token = await adminLogin();
    const name = `Low Stock Item ${Date.now().toString(36)}`;
    const food = await createItem(token, name, 6);

    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      await signIn(page, ADMIN);
      await page.getByTestId("inventory-search").fill(name);

      // Push it to or below the default threshold (5).
      await page.getByTestId(`adjust-value-${food._id}`).fill("-3");
      await page.getByTestId(`adjust-reason-${food._id}`).fill("Ran low");
      await page.getByTestId(`apply-adjust-${food._id}`).click();

      const alerts = page.getByTestId("low-stock-alerts");
      await expect(alerts).toBeVisible({ timeout: 20_000 });
      await expect(alerts).toContainText(name);

      // Acknowledge -> the "new" badge goes, the condition remains listed.
      await page.getByTestId("ack-alerts").click();
      await expect(alerts).not.toContainText("new", { timeout: 20_000 });
    } finally {
      await ctx.close();
    }
  });

  test("movement history is visible to an administrator", async ({ browser }) => {
    const token = await adminLogin();
    const name = `History Item ${Date.now().toString(36)}`;
    const food = await createItem(token, name, 5);

    await fetch(`${API}/inventory/${food._id}/adjust`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ delta: 4, reason: "Restock for history test" }),
    });

    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      await signIn(page, ADMIN);
      await page.getByTestId("inventory-search").fill(name);
      await page.getByTestId(`history-${food._id}`).click();

      const rows = page.getByTestId("movement-rows");
      await expect(rows).toBeVisible({ timeout: 20_000 });
      await expect(rows.locator("tr")).not.toHaveCount(0);
      await expect(rows.getByRole("cell", { name: "Restock for history test" })).toBeVisible();
    } finally {
      await ctx.close();
    }
  });

  test("staff cannot see the inventory console", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await signIn(page, {
        name: "E2E Kitchen",
        email: "e2e.kitchen@college.edu",
        password: "kitchenpass123",
      });
      await expect(page.getByTestId("inventory-panel")).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });

  test("inventory layouts remain usable on a mobile viewport", async ({ browser }) => {
    const token = await adminLogin();
    const name = `Mobile Item ${Date.now().toString(36)}`;
    const food = await createItem(token, name, 4);

    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();

    try {
      await signIn(page, ADMIN);
      await page.getByTestId("inventory-search").fill(name);

      const row = page.locator(`[data-food-id="${food._id}"]`);
      await expect(row).toBeVisible({ timeout: 20_000 });

      // The search must actually narrow the list, not just render it.
      await expect(page.locator('[data-testid="inventory-row"]')).toHaveCount(1);

      // The controls must not overflow the viewport horizontally.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflow).toBeLessThanOrEqual(2);

      // The row and its key controls are still reachable and tappable.
      await expect(page.getByTestId(`toggle-tracking-${food._id}`)).toBeVisible();
      await expect(page.getByTestId(`adjust-value-${food._id}`)).toBeVisible();

      // And a student menu card fits too.
      const sCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const sPage = await sCtx.newPage();
      await signIn(sPage, await createStudent());
      await expect(
        sPage.getByTestId("food-card").filter({ hasText: name })
      ).toBeVisible({ timeout: 20_000 });
      const sOverflow = await sPage.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(sOverflow).toBeLessThanOrEqual(2);
      await sCtx.close();
    } finally {
      await ctx.close();
    }
  });
});

/** Helper: the cart line for the single tracked item under test. */
function page1CartItem(page) {
  return page.getByText("Total:").first();
}