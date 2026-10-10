# College Canteen — Phase 0 Audit, Baseline and Plan

Scope of this document: inspect the existing application, establish a baseline,
verify each defect listed in the enhancement specification against the actual
code, and propose a prioritized, incremental plan. **No application behaviour
was changed in this phase.**

Commit baseline: `d63395e` (branch `arena/a1905755-shiny-garbanzo`).

---

## 1. Baseline results (actually run)

| Check | Command | Result |
|---|---|---|
| Frontend dependency install | `cd frontend && npm ci` | **Pass** |
| Frontend production build | `npm run build` | **Pass** — 516 modules, JS 395.94 kB (gzip 127.36 kB), CSS 22.98 kB. Only a non-fatal "outdated caniuse / baseline-browser-mapping" notice. |
| Frontend lint | `npx eslint .` | **Fails** before linting: `eslint.config.js` imports `@eslint/js`, `globals`, `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh` and `eslint/config`, none of which are in `frontend/package.json`. `npx` fetched ESLint 10 from the registry, which is not a declared dependency. |
| Backend dependency install | `cd backend && npm ci` | **Pass** (206 packages) |
| Backend tests | `npm test` | **191 tests: 4 pass, 187 fail.** All 187 failures are the same environmental error: `mongodb-memory-server` must download a MongoDB binary from `fastdl.mongodb.org`, which is not reachable from this sandbox. The tests themselves were not evaluated. |
| Frontend E2E (Playwright) | `npm run test:e2e` | **Not run.** It needs the same in-memory MongoDB binary plus Playwright browser binaries. |

**Consequence:** the backend suite has not been verified in this environment.
It needs to be run on a developer machine (or CI with internet access to
`fastdl.mongodb.org`), or with a local `mongod` pointed at via
`MONGOMS_SYSTEM_BINARY`. This is the first thing to fix in the test workflow
(see Plan, M0).

---

## 2. Inventory of the existing system

### 2.1 Repository layout

```
backend/   Express 5 + Mongoose 9 + Socket.IO 4 (CommonJS)
  app.js, server.js, config.js, realtime.js
  routes/      auth, food, order, inventory
  models/      User, FoodItem, Order, InventoryMovement
  services/    inventory.js  (reservation / consumption / release ledger)
  utils/       orderLifecycle.js, validators.js, ApiError.js
  middleware/  authMiddleware, rateLimit, errorHandler
  scripts/     seedAdmin.js, generateSecret.js
  test/        11 suites (node:test + supertest + mongodb-memory-server)
frontend/  React 18 + Vite 5 + Tailwind 3 + Axios + socket.io-client
  src/App.jsx, api.js, realtime.js, orderStatus.js
  src/components/  Login, Signup, StudentDashboard, AdminDashboard,
                   KitchenDisplay, InventoryPanel, OrderTimeline, FoodCard
  e2e/         5 Playwright specs + an e2e harness server (server.cjs)
docs/      (this file)
```

Roughly 11.7k lines of hand-written source across 80 tracked files.

### 2.2 API surface (current contract — must stay backward compatible)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/health` | — | uptime |
| POST | `/api/auth/signup` | public, rate-limited | role forced to `student` |
| POST | `/api/auth/login` | public, rate-limited | returns `{token, role, name, id, email}` |
| GET / PUT | `/api/auth/me` | any user | profile; PUT accepts `name`, `notificationPrefs` |
| GET / POST / DELETE | `/api/auth/me/favorites[/:foodId]` | any user | |
| POST | `/api/auth/logout` | any valid token | stateless; client discards token |
| GET | `/api/food` | public | query: `search, category, dietary, available, sort` |
| GET | `/api/food/categories` | public | |
| POST / PUT / DELETE | `/api/food[/:id]` | admin or staff | PUT allow-list includes `stock` (see defect D6) |
| POST | `/api/orders` | any user | body `{items:[{food,quantity}], pickupSlot?, notes?}` — totals computed server-side |
| GET | `/api/orders` | self | student's own orders |
| GET | `/api/orders/all` | staff/admin | optional `?status=` |
| GET | `/api/orders/kitchen` | staff/admin | live queue (Pending/Accepted/Preparing/Ready), oldest first |
| GET | `/api/orders/:id` | owner or staff | |
| PUT | `/api/orders/:id/status` | staff/admin | lifecycle-checked, optional `reason` |
| POST | `/api/orders/:id/cancel` | owner (student) or staff/admin | lifecycle-checked |
| GET | `/api/inventory` | admin | filters: `search, category, state` |
| GET | `/api/inventory/low-stock` | admin | |
| POST | `/api/inventory/low-stock/ack` | admin | |
| GET | `/api/inventory/:foodId/movements` | admin | ledger |
| POST | `/api/inventory/:foodId/tracking` | admin | enable/disable tracking |
| POST | `/api/inventory/:foodId/adjust` | admin | `delta` or `set`, reason mandatory |
| POST | `/api/inventory/:foodId/availability` | admin | sold-out toggle |

Socket.IO (authenticated with the same JWT):
- `order:updated` — to `user:<id>` and `order:<id>` rooms, payload `{eventId, orderId, status, previousStatus, at}`.
- `inventory:updated` — to the staff `canteen` room only, numbers only.
- Client→server: `order:subscribe`, `canteen:subscribe` (staff only), `canteen:unsubscribe`.

Error contract: `{ "message": string, "details"?: object }` with proper status codes
(400 validation, 401, 403, 404, 409 conflicts, 413, 429, 500 generic).

### 2.3 Data model and relationships

- **User** (`students`, `staff`, `admin`): `email` unique, `password` bcrypt (never serialized), `role`, `isActive`, `favorites → FoodItem[]`, `notificationPrefs`.
- **FoodItem**: price (2dp), category, dietary, spicy, prepTime, image, `available`; Phase 4 inventory: `trackInventory`, `stock`, `reserved`, `unit`, `lowStockThreshold`, audit fields. Virtuals: `availableQty`, `soldOut`, `lowStock`, `outOfStock`.
- **Order**: `student → User`; `items[]` with a **snapshot** of `name`, `price`, `quantity` and inventory bookkeeping (`reservedQty`, `stockReserved/Consumed/Released`); `status`; `statusHistory[]` (from/to/by/role/reason/at, capped by `$slice`); `total`, `subtotal`, `discount` (always 0 today), `pickupSlot` (stored, never set by the UI), `notes`, `estimatedReadyAt`, `cancelledAt`, `completedAt`, `paymentStatus` (enum, unused).
- **InventoryMovement**: append-only ledger; `operationId` is unique (idempotency gate); `food`, `order`, `type` (reserve/release/consume/adjustment), deltas, `actor`.

Relationships: Order → User (student), Order.items → FoodItem (by id, with snapshot), InventoryMovement → FoodItem / Order / User. Favorites are an array of FoodItem ids on User.

### 2.4 Authentication and authorization

- JWT (HS256 via `jsonwebtoken`), payload `{id}`, `expiresIn` default `1d`. Accepts `Authorization: Bearer <t>` or a bare token.
- Roles enforced by middleware: `adminMiddleware`, `staffMiddleware`, `adminOrStaffMiddleware`. Admin-only inventory routes; staff-or-admin order/food routes; kitchen socket room restricted to staff.
- `config.js` refuses to boot without `JWT_SECRET`, and refuses known-weak secrets in production.

### 2.5 Frontend structure

- `App.jsx` restores the session via `GET /auth/me`, then routes by role: student → `StudentDashboard`; staff/admin → `AdminDashboard` with a toggle to `KitchenDisplay`.
- `api.js` — Axios instance; base URL from `VITE_API_URL`; attaches Bearer token; normalizes errors to `{message, status}`; clears token on 401.
- `realtime.js` — Socket.IO client with de-duplication by `eventId`, reconnection, and status callbacks. Notifications trigger REST re-reads.
- Cart is persisted to `localStorage` (`CART_KEY`) in `StudentDashboard`.
- Favorites, reorder, cancel, ready-for-pickup notification and order timeline exist.

### 2.6 Existing features that work as described (verified by reading code)

Signup/login/session restore; server-side pricing; order lifecycle with role rules
and optional strict mode; inventory reservation/consumption/release with an
idempotent ledger; kitchen queue; realtime notifications with room authorization;
rate limiting on `/api` and stricter limiting on login/signup; centralized error
handling; security headers; CORS allow-list; body-size limits.

---

## 3. Verification of the specification's "critical defects"

Status key: **Fixed** = present in code and verified by reading; **Partial** = present but with a gap; **Open** = not fixed.

| # | Spec item | Status | Evidence / gap |
|---|---|---|---|
| D1 | Public users cannot register as admin | **Fixed** | `routes/auth.js` ignores `body.role`, always `student`. Admins only via `seedAdmin.js`. |
| D2 | Server-side order totals from DB prices | **Fixed** | `routes/order.js` looks up `Food` and snapshots price; client sends only `{food, quantity}`. |
| D3 | Validate quantities, IDs, prices, statuses | **Mostly fixed** | `utils/validators.js` covers types, ranges, ObjectIds, 2dp prices, `oneOf` for statuses. Gaps: `dietary`/`unit` free-form in several places; `image` only checked as http(s) URL (no host allow-list); `reason` on food is not validated for food writes. |
| D4 | Authenticated `GET /auth/me` for session restore | **Fixed** | `routes/auth.js` `GET /me`; `App.jsx` uses it. |
| D5 | Expired tokens, logout, missing users | **Partial** | Expired → 401 "Session expired". Missing user → 401. Logout endpoint exists but is stateless (token stays valid until expiry; no `tokenVersion`). **Deactivated users keep working** — see new defect N1. |
| D6 | Secrets secured, no hardcoded secrets | **Mostly fixed** | No secret in code; `JWT_SECRET` required; weak-secret guard. Remaining: `config.js` keeps a list of weak values (acceptable); test/e2e harness use fixed throwaway secrets (acceptable, not production). |
| D7 | Admin dashboard user-name integration | **Likely fixed, unverified** | `App.jsx` passes `userName` (set from `/auth/me` or login response) into `AdminDashboard` → `Welcome, {name}!`. Needs a Playwright check; the e2e suite was not run. |
| D8 | API base URL via env | **Fixed** | `VITE_API_URL` in `api.js`, `vite.config.js` proxy, `realtime.js` (`VITE_SOCKET_URL` fallback). `localhost:5000` remains as the dev default. |
| D9 | Centralized error handling, correct status codes | **Fixed** | `middleware/errorHandler.js`; Mongoose/duplicate-key/cast errors mapped; 500s hidden. |
| D10 | Rate limiting on auth endpoints | **Fixed** | `authLimiter` on `/signup` and `/login`; defaults 10 per 15 min; headers emitted. Note: limit is per-IP only, not per account. |
| D11 | Only authorized users reach admin operations | **Partial** | Inventory is admin-only at route level. But **staff can directly set `stock` through `PUT /food/:id`** (defect N2), bypassing the admin-only rule and the ledger. |

Conclusion: the core security items from the specification are largely already
implemented in this codebase. The remaining real defects are the new items below.

---

## 4. New defects found during the audit

| ID | Severity | Description | Location |
|---|---|---|---|
| N1 | **High** | `authMiddleware` never checks `user.isActive`. A deactivated account keeps full REST access until its JWT expires (up to 1 day). Login and realtime do check it, so the gap is REST-only. | `middleware/authMiddleware.js` |
| N2 | **High** | Staff can change physical `stock` via `PUT /api/food/:id`. This bypasses the admin-only inventory rule, writes no `InventoryMovement`, and can set stock below `reserved` (the available quantity is then clamped to 0, hiding the inconsistency). | `routes/food.js` (PUT, `stock` branch) |
| N3 | Medium | Deleting a `FoodItem` that has outstanding reservations leaves those orders without a stock record. Releases then silently skip (`findOneAndUpdate` returns null). No audit entry is written. | `routes/food.js` DELETE |
| N4 | Medium | `POST /food` ignores `stock`, `trackInventory`, `lowStockThreshold` and `unit`, so a new item cannot be stock-managed at creation. Enabling tracking requires a second call. | `routes/food.js` POST |
| N5 | Medium | `adjust` with `set` reads stock, computes a delta, then applies it non-atomically. Two concurrent `set` requests can apply a wrong delta. Delta mode is safe. | `routes/inventory.js` |
| N6 | Low | `reserveOne` returns an object with a stray `reserved_` key. `inventory.js` status filter uses a redundant ternary (`$lte` for both branches). | `services/inventory.js`, `routes/inventory.js` |
| N7 | Low | `extractToken` is duplicated (`realtime.js` and `authMiddleware.js`). | — |
| N8 | Low | `Order.paymentStatus`, `Order.discount`, `Order.pickupSlot` exist in the schema but are not produced by any UI flow. Only `pickupSlot` is accepted by the API. | `models/Order.js` |
| N9 | Build/tooling | ESLint cannot run (missing devDependencies). | `frontend/package.json`, `eslint.config.js` |
| N10 | Repo hygiene | Scratch/test-output files are committed: `backend/it.txt` (UTF-16 PowerShell output), `backend/st.txt`, `backend/tap.txt`, `frontend/pw.txt`, `frontend/pw2.txt`. They are not referenced by any code. | repository root of each package |
| N11 | Test workflow | Backend tests require a network download of MongoDB at run time; no documented offline path (`MONGOMS_SYSTEM_BINARY`, version pin, or CI cache). | `backend/test/helpers.js` |
| N12 | Docs | Root README is only a title. Frontend README is the Vite template. Setup steps are only in `.env.example` comments. | `README.md`, `frontend/README.md` |
| N13 | Auth | Logout does not revoke tokens (no `tokenVersion`). Password change/reset doesn't exist, so there is nothing to revoke on. | `routes/auth.js` |
| N14 | High | (Found in Phase 2.) Inventory counter changes run before the ledger row is claimed, so duplicate concurrent movements can double-apply `reserved`/`stock`. Tracked as P2-R1 in `PLAN.md`. | `services/inventory.js` |

---

## 5. Specification feature coverage

| Area | Feature | Status |
|---|---|---|
| Student | Searchable/filterable menu, categories, sorting | **Backend done** (`search, category, dietary, sort`). Front-end controls: to verify. |
| Student | Availability, dietary labels, images, prep times | **Mostly** — data present; UI display to verify. |
| Student | Cart quantity controls, persistent cart | **Done** (`localStorage`). |
| Student | Pickup time slots | **Partial** — `pickupSlot` accepted by API, not offered in UI. |
| Student | Item customization | **Missing.** |
| Student | Status history and estimated prep time | **Partial** — `statusHistory` and `estimatedReadyAt` exist; timeline shows status only. |
| Student | Configurable cancellation rules | **Done** (role matrix in `orderLifecycle.js`, env `ORDER_STRICT_LIFECYCLE`). Rules are code-defined, not env-configurable beyond strict mode. |
| Student | Favorites | **Done.** |
| Student | Reordering | **Done** (`StudentDashboard`). |
| Student | Reviews | **Missing.** |
| Student | Receipts | **Missing.** |
| Student | Notification preferences | **Partial** — stored and updatable via `PUT /me`; no UI that gates notifications on them (verify). |
| Admin/kitchen | Dashboard analytics, revenue reports | **Missing.** |
| Admin/kitchen | Advanced food and category management | **Partial** — CRUD + search/category; no category management endpoint. |
| Admin/kitchen | Inventory, alerts, sold-out handling | **Done** (ledger, low-stock alerts, ack, availability toggle). |
| Admin/kitchen | Kitchen display with real-time updates | **Done.** |
| Admin/kitchen | Coupons, discounts | **Missing** (`discount` field exists, always 0). |
| Admin/kitchen | CSV exports | **Missing.** |
| Admin/kitchen | Staff roles, permissions, audit logs | **Partial** — 3 fixed roles; audit exists for inventory and order transitions only; no general admin audit log; no per-permission model. |
| Advanced | Socket.IO notifications and tracking | **Done.** |
| Advanced | Payment-provider integration with verified confirmation | **Missing.** Needs a provider decision (see §7). |
| Advanced | QR-based ordering | **Missing.** |
| Advanced | PWA | **Missing** (no manifest, no service worker). |
| Advanced | Recommendations / demand forecasting | **Missing.** |

---

## 6. Compatibility risks

1. **Staff stock writes (N2).** Removing `stock` from staff `PUT /food` changes a response contract that existing staff workflows may use. Mitigation: keep the field in the allow-list for admins only and return a 403 with a clear message for staff. Verify the admin UI never sends `stock` in a food PUT first.
2. **Deactivated-user enforcement (N1).** Adding an `isActive` check to REST could lock out accounts that were deactivated on purpose — which is the intent — but must be tested to make sure only `isActive === false` is rejected. Missing `isActive` on legacy documents defaults to `true` in the schema, so this is safe.
3. **Schema evolution.** Every new field must have a default. Existing `Order` and `FoodItem` documents have no coupon, review, payment or customization fields; reads must treat missing values as null/empty.
4. **Transactions.** `withOptionalTransaction` shows the project already supports standalone MongoDB. Coupon usage limits and payment confirmation should use single-document conditional updates (the pattern already used for inventory), so they stay correct without requiring a replica set.
5. **Order totals.** Adding coupons or item customization changes the `total`. Keep `subtotal` and `total` semantics identical when no coupon/customization is present, so existing clients and tests keep passing.
6. **Test environment.** Any change to the backend can't be validated here until a MongoDB binary is available (see N11). Changes will be marked "verified by build/lint only" until then.
7. **Realtime.** New events must keep the rule "notifications only, re-read via REST", and must not leak order contents or stock figures to students.
8. **Frontend bundle size.** Current JS is ~396 kB. Analytics charts or a PDF library would add weight; prefer no new dependencies unless needed.

---

## 7. Prioritized plan

Each milestone is a separate, reviewable change, keeps the app runnable, and
adds automated tests. Milestones are ordered by risk. **Items marked ⚠ need a
decision from you before implementation** (see §8).

### M0 — Make the project verifiable (small, no behaviour change)
- Add the missing ESLint devDependencies (or remove the config) so `npm run lint` runs.
- Document the MongoDB binary requirement; support `MONGOMS_SYSTEM_BINARY` / version pin so tests can run offline.
- Move scratch output files out of Git (`git rm` only after confirming with you; they are not referenced by code).
- Add the root README setup guide (install, env, seed admin, run backend/frontend, run tests).
- Add a `CHANGELOG.md` (created in this phase).
- **Exit criteria:** `npm run build`, `npm run lint`, and `npm test` run in a documented way; the 4/187 gap is explained or closed.

### M1 — Security and correctness hardening (P0)
- **N1:** enforce `isActive` in `authMiddleware` and `optionalAuthMiddleware`.
- **N2:** restrict `stock` writes in `PUT /food/:id` to admin, or remove them and point staff to the inventory service. Route any stock change through the ledger.
- **N3:** on food DELETE, refuse when the item has outstanding reservations (409) or require the ledger to be released first.
- **N4:** let admins create tracked items through `POST /food` (optional, default unchanged).
- **N5:** make `set` adjustments atomic (conditional update on the observed stock value, retry or 409 on conflict).
- **N6/N7:** small cleanups.
- **Tests:** student/staff/admin boundary matrix for every admin route; deactivated user gets 401 on REST and socket; staff cannot change stock; price tampering; concurrent `set` adjustments; delete-with-reservations.
- **Exit criteria:** all new tests pass where MongoDB is available; existing tests still pass.

### M2 — Student menu and cart experience
- Menu UI: search box, category chips, dietary filter, sort dropdown, availability badge, prep-time badge, image fallback (backend endpoints already exist).
- Pickup time slot picker (sends existing `pickupSlot`; slot list configured by env/config, validated server-side).
- Keep the existing cart; add quantity limits from server config in the UI.
- **Tests:** Playwright for filter/sort/cart persistence after reload; API tests for sort/filter combinations and invalid `sort`.

### M3 — Order tracking, cancellation, receipts, notifications
- Show full `statusHistory` and `estimatedReadyAt` in the student timeline (data already returned).
- Receipt view (printable HTML page or CSV) built from the existing order document; no PDF library.
- Honor `notificationPrefs` in the realtime layer and in the UI (`orderUpdates`, `sound`).
- Cancellation rules: keep the existing role matrix; add an env-configurable student cancellation window only if you want one (⚠).

### M4 — Admin: analytics, exports, audit log, staff permissions
- Read-only analytics endpoints using MongoDB aggregation: orders per day, revenue per day, top items, average prep time, status counts. Date-range params, admin-only.
- CSV export endpoints (orders, revenue, inventory) with formula-injection protection (prefix cells beginning with `= + - @`).
- Generic `AuditLog` model: actor, role, action, target, before/after (non-sensitive fields only), IP, time. Written for food, inventory, order-transition and staff changes.
- Staff permissions: keep the three roles; add a small permissions map (`menu:write`, `orders:manage`, `inventory:write` …) derived from role. No new roles are added without your approval.
- Admin dashboard: add an analytics panel and export buttons.

### M5 — Coupons and discounts
- `Coupon` model: code (unique, normalized), percent or fixed amount, minimum order, validity window, usage limit, per-user limit, active flag.
- Applied server-side at `POST /orders`; discount stored on the order (`discount` field already exists). Totals recomputed server-side.
- Usage counter updated with a conditional `$inc` (`usedCount < usageLimit`) so limits hold under concurrency without transactions.
- Admin CRUD for coupons (admin only) and audit entries.
- **Tests:** expired/inactive/over-limit codes rejected; concurrent redemption of the last use succeeds exactly once; totals unchanged when no coupon is supplied.

### M6 — Reviews and favorites polish
- Reviews: one per user per food item, allowed only after the user has a `Completed` order containing that item; rating 1–5 with optional comment; aggregate rating on the food item.
- Favorites already exist; add favorites filter in the menu.

### M7 — Payments ⚠ (paid service — do not start without a decision)
- Provider choice, sandbox credentials and whether to support cash-only as well. This milestone must not hold any secrets in code.
- Design: order created as `paymentStatus: "unpaid"` → provider checkout → **server-side verification** of the provider's signature or a server-to-server fetch → only then mark `paid`. Webhook endpoint with raw-body signature verification and idempotency keyed on the provider event ID.
- Refunds on cancellation before preparation, if you want that behaviour.

### M8 — QR ordering, PWA, recommendations (optional, scope to confirm)
- QR ordering: a `Table` or `Counter` model with signed codes; the QR links to `/menu?t=<code>`; the order stores the table reference. Needs your confirmation of the physical setup (⚠).
- PWA: web manifest and an app-shell service worker written by hand (no new plugin) so offline support is limited to the static shell. Menu data is not cached offline.
- Recommendations: co-occurrence ("customers who ordered X also ordered Y") computed from completed orders with an admin-triggered job. Demand forecasting: 7-day moving average per item, shown as a suggestion only, never as an automatic stock change.

---

## 8. Decisions needed from you (⚠)

1. **Payments (M7):** do you want a payment provider integrated at all? If yes, which one (for example Razorpay or Stripe), and will you supply sandbox keys? Integrating a live provider is a paid/external action, so I will not do it without your explicit approval.
2. **QR ordering (M8):** one QR per table/counter, or one per canteen counter? Is ordering from the QR open to all students or only logged-in ones?
3. **Cancellation window (M3):** should students be able to cancel only before preparation (current rule), or within a configurable time window?
4. **Scratch files (N10):** may I remove `backend/it.txt`, `backend/st.txt`, `backend/tap.txt`, `frontend/pw.txt` and `frontend/pw2.txt` from Git?
5. **`a.html` at the repo root:** this is the placeholder file I created at your earlier request. Keep or delete?
6. **Staff stock access (N2):** should staff be able to change stock at all (through the inventory screen with a reason), or admin-only? The current inventory API is admin-only, so I recommend admin-only.
7. **Deployment:** I will not deploy anything. Confirm that deployment is out of scope for this work.

---

## 9. Immediate next step

On your confirmation of §8 (especially items 4, 5 and 6), I propose to start **M0** (verifiability) followed by **M1** (security hardening), each as its own small commit with tests and a changelog entry.
