# Changelog

All changes are listed per milestone. Test results record what was actually run.

## Phase 0 — Audit and baseline (no application behaviour changed)

### Files added
- `docs/AUDIT.md` — inventory, API contract, data model, verification of the
  specification's defects, new defects (N1–N13), feature coverage, compatibility
  risks and the prioritized plan (M0–M8).
- `CHANGELOG.md` — this file.

### Features added
- None.

### Bugs fixed
- None (audit only).

### Migrations introduced
- None.

### Tests and checks performed

| Check | Result |
|---|---|
| `frontend`: `npm ci` | Pass |
| `frontend`: `npm run build` | Pass (516 modules; JS 395.94 kB, gzip 127.36 kB; CSS 22.98 kB) |
| `frontend`: `npx eslint .` | Fail — `eslint.config.js` depends on packages not declared in `package.json` |
| `backend`: `npm ci` | Pass (206 packages) |
| `backend`: `npm test` | 191 tests — 4 pass, 187 fail. All failures come from `mongodb-memory-server` being unable to download a MongoDB binary (`fastdl.mongodb.org` is not reachable from the sandbox). Not a code result. |
| Frontend Playwright E2E | Not run (needs the same MongoDB binary plus browser binaries) |

### Known open items (from the audit)
- N1 — deactivated users keep REST access until their token expires.
- N2 — staff can change physical stock via `PUT /api/food/:id`.
- N3–N13 — see `docs/AUDIT.md` §4.

## Phase 2 — Order lifecycle state machine and student cancellation

Scope: documentation, verification and tests for the lifecycle and cancellation
behaviour that is already in the repository. No application route, response
field, status value or database field was changed.

### Files added
- `backend/test/lifecycleMatrix.test.js` — 308 pure tests (no database). Checks every
  role × from-status × to-status combination, in skip-ahead and strict modes, against
  a hand-written expectation table. Also checks `allowedTransitions`, `canCancel` and
  `requiresReason`, and the status vocabulary.
- `docs/API.md` — order endpoints, transition tables, reason rules, error cases,
  audit fields, inventory side effects and compatibility notes.
- `PLAN.md` — the project status file the Phase 2 specification refers to. It did not
  exist before. It records phase status, open items and the verification environment.

### Files changed
- `docs/AUDIT.md` — added defect N14 (the inventory ledger race, found in this phase).
- `CHANGELOG.md` — this entry.

### Features added
- None to application behaviour. The lifecycle and student cancellation were already in
  the code; this phase verified them and documented them.

### Bugs fixed
- None in this phase.
  (A test expectation I wrote for `Pending → Pending` returned 409, not 403. The
  implementation is correct: the same-state check runs before the role check. I corrected
  the test. The implementation was not changed.)

### Migrations introduced
- None.

### Verified behaviour (by reading the code)
- Transitions are checked on the server against `utils/orderLifecycle.js`. Client-supplied
  status values are validated; the state is checked again in the conditional database write.
- Student cancel: ownership, state (Pending/Accepted only) and idempotent repeat.
- Staff cannot reject, and cannot cancel once cooking starts. Admin is the only role that
  may cancel Preparing/Ready.
- Reasons are required for admin/staff cancellation and for admin rejection.
- Terminal states cannot be left.
- Each successful transition appends `{status, from, at, by, role, reason}` to
  `statusHistory` in the same write as the status change. Failed requests do not append.

### Tests performed

| Check | Command | Result |
|---|---|---|
| Lifecycle matrix (pure, no DB) | `node --test test/lifecycleMatrix.test.js` | **308 / 308 pass** |
| Frontend production build | `npm run build` | **Pass** (516 modules, built in 2.72 s) |
| Full backend suite | `npm test` | 499 run: **312 pass, 187 fail.** All 187 fail because `mongodb-memory-server` cannot download MongoDB (`fastdl.mongodb.org` unreachable). The route-level Phase 1/Phase 2 tests were **not executed**. |
| Browser / Playwright | not run | Requires MongoDB and browser binaries. |

Route-level suites that need the database and were not executed here:
`orderLifecycle.test.js` (concurrency, ownership, audit, idempotency),
`order.test.js`, `kitchen.test.js`, `integration.test.js` (Phase 2 HTTP workflows),
`inventory.test.js`, `realtime.test.js`.

### Known open items (see `PLAN.md`)
- P2-R1 (High) — inventory counters can double-apply under concurrent transitions on one
  order, because the ledger row is written after the counter change. Not fixed here: it
  changes inventory core code and needs database tests to validate.
- P2-R2 (Medium) — inventory effects after a committed transition are not retried.
- P1-N1 and P1-N2 (High) — Phase 1 items still open in the code (deactivated-user REST
  access; staff stock writes).

## Fix-all pass before Phase 3 (P2-R1, P2-R2, P1-N1/N2/N7/N13, N3–N6, P0-N9–N12)

Scope: every open item in `PLAN.md`, approved by the project owner ("fixx all before i give u phase 3").
`a.html` was kept. Each database-backed change below is **unverified in this environment**: no
MongoDB binary could be run here. The pure tests and build checks listed under "Tests and checks" did run.

### Files added
- `backend/test/sessionRules.test.js`: 14 DB-free tests of token, deactivation and revocation rules (user lookup stubbed).
- `backend/test/sessionRevocation.test.js`: DB-backed HTTP and Socket.IO tests for logout revocation, deactivation, legacy tokens and handshake rules.
- `backend/test/foodStockAuthz.test.js`: DB-backed tests for stock authorization on PUT, the DELETE guard, and admin-only inventory fields on POST.
- `backend/test/inventoryConcurrency.test.js`: DB-backed concurrency invariants: no lost update on adjust set/delta, no oversell, single consume, single release, and reservation claimed once.
- `backend/test/pendingInventory.test.js`: DB-backed P2-R2 tests. A simulated outage after a committed status change is retried to completion exactly once.
- `README.md`: setup, configuration, running the tests (including `MONGOMS_SYSTEM_BINARY`), and maintainer notes.
- `PLAN.md`: rewritten with the status of every item.

### Files changed
- `backend/middleware/authMiddleware.js`: `resolveSessionUser` (signature, exists, `isActive`, `tokenVersion`) used by REST and sockets; shared `extractToken` for HTTP and handshake.
- `backend/models/User.js`: `tokenVersion` (default 0).
- `backend/routes/auth.js`: tokens carry `tv`; logout increments `tokenVersion`.
- `backend/realtime.js`: socket auth uses the shared validator and token extractor; duplicate parser removed.
- `backend/routes/food.js`: stock writes admin-only; tracked stock must go through the ledger; DELETE guard; admin-only inventory fields on create, with starting stock ledgered.
- `backend/services/inventory.js`: claim-first for every movement; `adjustStock` takes `set` or `delta` with a conditional filter (`CONCURRENT_UPDATE`); `setTracking` ledgers stock differences; `reserveOrder` compensates only without transactions; `transactionsSupported` is no longer cached.
- `backend/routes/inventory.js`: `set` passed to the service (no pre-read); redundant ternary removed; `InventoryError` code returned in the body.
- `backend/middleware/errorHandler.js`: includes `code` in the body when an error carries one.
- `backend/models/Order.js`: `inventoryPendingKind`, `inventoryPendingReason` (both default null).
- `backend/routes/order.js`: pending markers written with the status change; pending work completed first in `PUT /:id/status` and `POST /:id/cancel`; retry of an applied transition returns 200.
- `frontend/eslint.config.js`, `frontend/package.json` (+`lint` script, devDependencies), `frontend/package-lock.json`: working ESLint setup.
- `frontend/src/components/StudentDashboard.jsx`: see Bugs fixed.
- `frontend/src/components/InventoryPanel.jsx`: unused ref removed.
- `frontend/e2e/kitchen.spec.js`: unused binding removed.
- `docs/API.md` §4 (pending fields), §3 (retry rules), §5 (inventory wording), §7 (auth, food, adjust, tracking).
- `docs/AUDIT.md`: status table for §4 added.

### Files removed
- `backend/it.txt`, `backend/st.txt`, `backend/tap.txt`, `frontend/pw.txt`, `frontend/pw2.txt` (scratch files, P0-N10).

### Features added
- Pending-inventory markers and automatic completion on retry (P2-R2).
- Logout revocation through `tokenVersion` (P1-N13).
- `npm run lint` in `frontend/`.

### Bugs fixed
- **Student dashboard crash (introduced in `d63395e`).** `StudentDashboard.jsx` referenced `refreshFoods` in a dependency array before it was defined, so the dashboard threw `ReferenceError` on every render. The Vite build passes because it does not check undefined identifiers. Also fixed: a `useCallback` nested inside an effect, and a stale `cart` closure in `addToCart`. Verified by server-rendering the committed file (fails) and the fixed file (renders). This is not a browser test.
- **P1-N1** deactivated accounts were refused only at login and on sockets. REST routes now refuse them too.
- **P1-N2** staff could set stock through `PUT /api/food/:id`.
- **P2-R1** inventory counters changed before the ledger claim (double-apply risk under concurrency).
- **P2-R2** a failed inventory step after a committed status change was never retried.
- **N3** deleting an item with open reservations orphaned them.
- **N4** an item could not be stock-managed at creation.
- **N5** concurrent `set` adjustments could compute a wrong delta.
- **N6** stray `reserved_` key; redundant ternary.
- **N7** duplicate `extractToken`.
- **Review fixes:** transactional `reserveOrder` could compensate lines already rolled back and could double-count on transaction retry; `transactionsSupported` cached a pre-connection `false`; `setTracking` changed stock without a ledger delta; a failed starting-stock step left a half-configured item.

### Behaviour changes (API)
- Staff `PUT /api/food/:id` with `stock` → `403` (was `200`).
- Admin `PUT /api/food/:id` with `stock` on a tracked item → `400` (was `200`).
- Staff `POST /api/food` with inventory fields → `403`.
- `DELETE /api/food/:id` with reservations → `409`.
- Logout ends all sessions for that account (documented in `docs/API.md` §7.2).
- Inventory adjust responses include `code` (e.g. `CONCURRENT_UPDATE`).

### Migrations introduced
- Additive only, no script required. `User.tokenVersion` and `Order.inventoryPendingKind` / `inventoryPendingReason` default when absent. Existing tokens work until logout.

### Known limitations
- Standalone MongoDB: a crash between a ledger claim and its counter change leaves that movement unapplied (not doubled). Replica sets are atomic.
- Logout is account-wide by design.
- Pending inventory work is completed by the next status-changing request for that order, not in the background.

### Tests and checks performed

| Check | Command | Result |
|---|---|---|
| Frontend lint | `npx eslint .` | **Pass**: 0 errors, 4 warnings (`react-hooks/set-state-in-effect`, deliberately warn-level) |
| Frontend build | `npm run build` | **Pass** |
| StudentDashboard render (committed vs fixed) | `esbuild` bundle + `react-dom/server` | Committed: `ReferenceError`. Fixed: renders. (Render only, not a browser test.) |
| Backend module load | `node -e "require(...)"` on every changed module | **Pass** |
| Session rules (DB-free) | `node --test test/sessionRules.test.js` | **14 / 14 pass** |
| Lifecycle matrix (DB-free) | `node --test test/lifecycleMatrix.test.js` | **308 / 308 pass** |
| New DB-backed suites | `sessionRevocation`, `foodStockAuthz`, `inventoryConcurrency`, `pendingInventory` | **Written, syntax-checked, NOT executed** (need MongoDB) |
| Full backend suite | `npm test` | **551 run: 326 pass, 225 fail.** All 225 failures are `hookFailed` (the `before` hook could not start MongoDB: `fastdl.mongodb.org` blocked). Zero assertion failures. The 38 new DB-backed tests did not execute. Before this pass: 499 run, 312 pass, 187 fail, same cause. |
| Playwright | `npm run test:e2e` | Not run |
| Browser | — | **Not performed** |

## Student experience: Phase 1 gap closure (follow-up)

A review against the feature spec found four gaps. This entry closes them, in
code only. It is still unverified in a browser and against the database.

### Fixed

- **Staff could not enter the new menu fields.** The admin screen could only
  create name, description, price and image. It now has a "More details" section
  (category, diet, prep time, featured, ingredients, allergens, add-ons) and an
  **Edit** button on each item. Edits go through `PUT /api/food/:id`. Validation is
  in `frontend/src/lib/foodForm.js` (`formToPayload`), which rejects bad input before
  any request is sent.
- **`dietary` was not updatable.** `PUT /api/food/:id` ignored it, and `POST`
  stored it unchecked. Both now go through `parseDietary` (`backend/utils/discovery.js`):
  a known value is accepted, empty clears it, anything else is a 400.
- **Notification preferences did nothing.** The dashboard now loads them and
  applies them. `orderUpdates` off means no pickup alert. `sound` on plays a short
  chime when an order becomes ready (`frontend/src/lib/notify.js`). The Account
  panel reports changes back to the dashboard, so no reload is needed.
- **Students could not read reviews.** The food card has a "Read reviews" toggle
  that loads `GET /api/reviews/food/:id` the first time it is opened. It shows
  rating, comment and date only.

### Changed

- Student-facing status wording: "Pending confirmation" and "Ready for pickup".
  The stored values are unchanged (`Pending`, `Ready`). The kitchen board shares the
  timeline component, so staff now see the same wording.
- The promotions toggle is labelled "(none are sent yet)".

### Still not done

- Estimated wait is set once at placement and not recalculated.
- Pickup slots have no capacity limit.
- No payments or refunds, and no email or push notifications.
- `promotions` has no effect because no promotions are sent.

### Verification (this follow-up)

| Check | Result |
|---|---|
| Backend pure suites (`lifecycleMatrix`, `sessionRules`, `studentCheckout`, `studentPricing`, `studentDiscovery`, `studentPure`) | 375 of 375 pass (includes new `parseDietary` test) |
| Frontend unit (`npm run test:unit`) | 38 of 38 pass (13 new: `foodForm`, `notify`, status labels) |
| `npx eslint .` | 0 errors, 3 warnings (pre-existing, `App.jsx` and `InventoryPanel.jsx`) |
| `npx vite build` | Succeeds |
| Server-side render (`/tmp` harness) | Admin screen, details fields, timeline wording, food card reviews toggle, and order card render as expected |
| Database-backed tests (`studentFeatures.test.js` and the existing suites) | **Not run.** No MongoDB binary in this sandbox |
| Browser and Playwright checks, including clicking the admin editor, the reviews toggle, and the chime | **Not run.** No browser in this sandbox |

## Student experience: Phase 1 of the feature spec (discovery, cart, tracking, account)

Scope from the spec: discovery, cart and checkout, order tracking, and account.
Status: implemented. The pure tests and the frontend build pass here. The
database-backed tests and browser checks were **not run** (no MongoDB binary and
no browser in this sandbox). See the verification table at the end.

### Files added

- Backend: `models/Coupon.js`, `models/Review.js`, `routes/coupons.js`,
  `routes/reviews.js`, `services/checkout.js` (cart resolution shared by quote and
  placement), `utils/discovery.js`, `utils/pricing.js`, `utils/pickupSlots.js`,
  `utils/receipt.js`, `utils/reviews.js`, `utils/orderHistory.js`.
- Backend tests: `test/studentPricing.test.js`, `test/studentDiscovery.test.js`,
  `test/studentPure.test.js`, `test/studentCheckout.test.js` (all DB-free, run and
  pass). `test/studentFeatures.test.js` (DB-backed, **written, not run**).
- Frontend: `src/lib/cart.js`, `src/lib/menuFilters.js`, `src/lib/orderHistory.js`,
  `src/lib/orderView.js`, `src/lib/download.js`; components under
  `src/components/student/` (`FoodCard`, `MenuFilters`, `CartPanel`,
  `PickupSlotPicker`, `OrderCard`, `OrderHistoryFilters`, `ReviewPanel`,
  `AccountPanel`).
- Frontend tests: `tests/unit/cart.test.js`, `tests/unit/studentLib.test.js`
  (`npm run test:unit`, Node's built-in test runner, no new dependency).

### Files changed

- `backend/config.js`: `canteen` block (name, UTC offset, opening hours, slot
  length, days, prep buffer, tax, packaging, bestseller count, new-item window).
  All values are environment-driven and default to the previous behaviour.
- `backend/models/FoodItem.js`: additive `featured`, `addOns`, `ingredients`,
  `allergens`, `orderCount`, `ratingSum`, `ratingCount`, `ratingAverage`.
- `backend/models/Order.js`: item `addOns`, `basePrice`, `specialInstructions`;
  order `pickupAt`, `charges`, `couponCode`.
- `backend/models/User.js`: `toPublicJSON()` now includes `phone` and
  `notificationPrefs`.
- `backend/routes/order.js`: `POST /` priced through `services/checkout.js`;
  new `POST /quote`, `GET /slots`, `GET /:id/receipt`; `GET /` takes history filters.
  `/slots` and `/quote` are registered before `/:id`.
- `backend/routes/food.js`: discovery filters and sorts, `badges` on each item,
  `GET /:id`, admin/staff can set `featured`, `addOns`, `ingredients`, `allergens`.
- `backend/routes/auth.js`: `PUT /me` accepts `phone`; new `POST /me/password`.
- `backend/app.js`: mounts `/api/reviews` and `/api/coupons`.
- `frontend/src/components/StudentDashboard.jsx`: rewritten to compose the new
  components. The realtime client, ready alerts, Live/Offline indicator, favourites
  and cancel flow are kept. Test IDs used by the e2e specs are kept
  (`food-card`, `add-to-cart`, `sold-out`, `availability-<id>`, `checkout`,
  `order-card`, `order-status`, `cancel-order`, `ready-alert`, and the first
  "Total:" on the page).
- `frontend/package.json`: `test:unit` script.

### Features added (spec item to what was built)

- **Discovery.** Search (name, description, category), category, veg / non-veg
  (egg counts as non-veg), exact dietary value, price range, available only,
  featured, favourites only (client-side), sort by name, price, most ordered, top
  rated, or newest. Badges: Featured (admin flag), Bestseller (top 5 by units
  ordered, over the whole menu, never-ordered items excluded), New (created in
  the last 7 days). Each card shows image, prep time, ingredients, allergens and
  rating.
- **Cart and checkout.** Quantities, saved cart (localStorage, with older saved
  carts upgraded), menu-defined add-ons (priced by the server), special
  instructions (140 characters), pickup slot, coupon code, and an itemized bill
  (subtotal, discount, charges, total). Unavailable and sold-out items are refused
  by the server with 409. The bill is priced by `POST /api/orders/quote`, the same
  code path as checkout.
- **Pickup slots.** 15-minute grid in canteen-local time (IST by default), open
  09:00 to 18:00, two days ahead. The earliest slot is the longest prep time in
  the cart plus a 5-minute buffer. A pickup time must be an exact open slot.
  Leaving it empty means "as soon as ready", as before.
- **Coupons.** Percentage or flat, with a minimum subtotal, an optional cap, an
  optional expiry, an active flag, and an optional usage limit. A redemption is
  claimed with a conditional atomic update, so a limited coupon cannot be used
  past its limit by concurrent checkouts. A failed order releases the claim.
- **Tracking.** Existing timeline and realtime updates. Added: "About N min left"
  countdown from the estimate, pickup time, and cancel shown only when the server
  reports `canCancel`.
- **Account.** Profile (name, phone), notification preferences (now editable),
  password change (current password required; other sessions are revoked and the
  new token replaces the old one on this device), favourites (existing), reorder
  (keeps the chosen options; prices are re-read at checkout), reviews after
  completion (1 to 5 stars, once per item per order; updates the item's average),
  history filters (status, from and to dates), and plain-text receipt download.

### Behaviour changes (API)

- `GET /api/food`: an unknown `dietary` or `veg` value is now a 400. It previously
  matched nothing and returned an empty list. Unknown `sort` values remain 400.
- `GET /api/orders`: with no parameters it still returns the full history. `limit`
  is optional and capped at 500.
- `POST /api/orders`: accepts `items[].addOns` (labels), `items[].specialInstructions`,
  `pickupAt` and `couponCode`. The response adds `subtotal`, `discount`, `charges`
  and `couponCode`. `total` is the bill total. For a cart with no coupon and no
  charges it equals the subtotal, as before.
- Order items gain `addOns`, `basePrice` and `specialInstructions`. For new orders,
  `price` is the unit price **including** add-ons, so `price x quantity` is the line
  total. `basePrice` holds the base price. Older orders have no `basePrice`.
- `PUT /api/auth/me` accepts `phone`. `POST /api/auth/me/password` is new.
- `POST /api/food` and `PUT /api/food/:id` accept `featured`, `addOns`,
  `ingredients` and `allergens` (admin or staff). Stock fields are unchanged.

### Migrations introduced

None required. Every new field has a default, so existing documents load and
serialize as before. Coupons and reviews are new collections, created on first
write. Existing menu items get `ratingAverage: 0` and `orderCount: 0` by default.

### Known limitations (not built)

- **No payments and no refunds.** Payment status is shown as stored (`unpaid` by
  default). Nothing is charged or refunded.
- **Pickup slots have no capacity limit.** The grid is a time choice only. Slots are
  not reserved and cannot fill up.
- **Coupon limits are global**, not per student.
- **Reviews** cannot be edited or deleted and are not moderated. Public reviews show
  the rating, comment and date only, never the reviewer.
- **Cart is per browser** (localStorage). It is not synced between devices.
- **Receipt** is plain text, not PDF.
- **Notification preferences are stored but not delivered.** No email or SMS channel
  exists yet.
- **Reorder** cannot check whether an old add-on still exists until checkout, when
  the server refuses it with a 400.
- **Bestsellers** use lifetime units ordered, with no time window.
- **Favourites filter** runs in the browser on the loaded menu.

### Tests and checks performed (this environment)

| Check | Command | Result |
|---|---|---|
| Backend pure suites | `node --test test/lifecycleMatrix.test.js test/sessionRules.test.js test/studentCheckout.test.js test/studentPricing.test.js test/studentDiscovery.test.js test/studentPure.test.js` | **374 / 374 pass** |
| Backend DB-backed student suite | `test/studentFeatures.test.js` | **Written, syntax-checked, NOT executed** (no MongoDB binary) |
| Backend DB-backed suites (existing) | `npm test` | **Not executed** (no MongoDB binary) |
| Frontend unit tests | `npm run test:unit` | **25 / 25 pass** |
| Frontend lint | `npx eslint .` | 0 errors. 3 warnings, all in code this change did not touch (`App.jsx`, `InventoryPanel.jsx`). Every new file is clean. |
| Frontend build | `npx vite build` | **Pass** |
| Server render of the student screens | `esbuild` bundle plus `react-dom/server` | Renders `StudentDashboard`, `FoodCard` (available, sold-out, exhausted), `CartPanel` (with and without a cart), `OrderCard` (Pending, Completed, Rejected), history and menu filters, and `AccountPanel`. Test IDs present, and Cancel and Rate buttons appear only when eligible. Render-only, not a browser test. |
| Playwright end-to-end | `npm run test:e2e` | **Not run** (needs MongoDB and a browser) |
| Browser | — | **Not performed** |

## Phase 1 remaining gaps: live wait, pickup capacity, email and push notifications

Closes the three Phase 1 gaps that were still open: the estimated wait was set
once at placement, pickup slots had no capacity, and email and push were not
built. Additive changes only. No existing route, field or status changed meaning.

### Features added

- **Live estimated wait.** The estimate is recalculated on placement, status change,
  cancellation, and every `KITCHEN_ETA_REFRESH_SECONDS` (default 60). A FIFO queue
  model with `KITCHEN_PARALLEL_ORDERS` (default 3) working at once. Only changes
  over 60 seconds are written and emitted, as `order:updated` with the unchanged status.
- **Pickup slot capacity.** `PICKUP_SLOT_CAPACITY` (default 20, 0 = unlimited).
  Seats are counted with conditional updates, so the last seat cannot be sold twice.
  `GET /api/orders/slots` returns `capacity` and each slot's `seatsLeft` and
  `available`. Quote and placement return 409 for a full slot. A cancel or
  rejection releases the seat once.
- **Email and browser push notifications.** An outbox (`Notification`) records each
  order status change and each admin announcement. A timer (`NOTIFY_DISPATCH_SECONDS`,
  default 30) sends them. Each channel has its own state and retry limit
  (`NOTIFY_MAX_ATTEMPTS`, default 3). Both channels are opt-in per student and need
  server configuration. Nothing is sent otherwise.
- **Routes.** `GET /api/notifications/push-key`,
  `POST` and `DELETE /api/notifications/push-subscriptions`,
  `POST /api/notifications/announcements` (admin only).
- **Account.** `notificationPrefs.email` and `notificationPrefs.push` in the account
  panel. Browser push subscribes through `public/sw.js` and `lib/push.js`.
- **Admin.** Announcement form (`AnnouncementPanel.jsx`) to students who opted into
  promotions. `promotions` now has an effect.
- **Picker.** Full pickup slots are shown as "(full)" and cannot be chosen.

### Schema changes (additive)

- `Order`: `prepMinutes`, `preparingAt`, `estimateUpdatedAt`, `pickupSeatHeld`.
  Defaults are set, so older documents load unchanged.
- `User`: `notificationPrefs.email`, `notificationPrefs.push` (default `false`), and
  `pushSubscriptions` (`select: false`, never returned by `/me`).
- New collections: `notifications`, `pickupslotcounts`. Created on first write.

### Migrations introduced

None required. Existing orders without `pickupSeatHeld` count as holding a seat, and
their slot counter is seeded from active orders the first time the slot is used.

### Dependencies added

- `backend`: `nodemailer@^7.0.13`, `web-push@^3.6.7`.

### Known limitations (not built or not verified)

- **Email and push were not tested against real services.** The tests use fake
  transports. No SMTP server or push service was contacted from this environment.
- **Single process only.** The dispatcher's guard is in memory. Several server
  processes would send duplicates until a claim step is added.
- **Seat release can leak on a rare failure.** If the release fails after the order is
  saved, the error is logged and the seat stays held. Nothing re-counts it automatically.
- **The wait is a model, not a measurement.** A stopped kitchen or a slow dish is not seen.
- **Coupon limits remain global**, and **no payments or refunds** (unchanged).

### Tests and checks performed (this environment)

| Check | Command | Result |
|---|---|---|
| Backend pure suites (8 files) | `node --test` on `lifecycleMatrix`, `sessionRules`, `studentCheckout`, `studentPricing`, `studentDiscovery`, `studentPure`, `kitchenQueue`, `notificationPlan` | **403 / 403 pass** (includes 28 new: queue ordering and cancel recalculation, channel rules, retry limit, seat math) |
| Backend full suite | `npm test` | **659 tests: 407 pass, 252 fail.** All 252 failures come from MongoMemoryServer being unable to download a MongoDB binary (`fastdl.mongodb.org` is blocked here). They are not code results. The DB-backed tests for this change (14 new in `studentFeatures.test.js`: capacity, cancel release, estimate recalculation, outbox and dispatch, retry, push subscriptions, announcements, dietary validation) were **written and syntax-checked, NOT executed**. |
| Frontend unit tests | `npm run test:unit` | **38 / 38 pass** |
| Frontend lint | `npx eslint src public` | 0 errors. 3 warnings in `App.jsx` and `InventoryPanel.jsx`, which this change did not touch. |
| Frontend build | `npm run build` | **Pass** |
| Browser | — | **Not performed.** The push subscribe flow and the picker's disabled state have not been clicked in a browser. |

## Admin management: Phase 2 spec, sections 5–8 (analytics, kitchen, inventory, menu)

Scope is the admin-management spec. It is separate from the order-lifecycle Phase 2 above.

### Features added
- **Sales analytics** (admin): summary, revenue by day, week (Monday start) or month, top and least-popular items, peak hours, and refunds. Sales exclude Cancelled and Rejected. Days are canteen-local. Ranges are capped at 366 days. (`utils/analytics.js`, `routes/analytics.js`)
- **CSV export** of orders (no student identity) or item totals, RFC 4180 with a BOM and a formula guard. (`utils/csv.js`, `GET /api/analytics/export.csv`)
- **Refund summary from recorded status only.** `refunded` orders are counted. Cancelled or rejected orders with `paid` status are flagged for manual refund. No refund is created.
- **Kitchen role** (`kitchen`) with its own screen. Kitchen accounts can move orders only to Accepted, Preparing, or Ready. They cannot complete, cancel, or reject. Admin dashboard unchanged for admins and staff. (`kitchenAccessMiddleware`, `App.jsx`)
- **Kitchen queue order and rush priority.** Rush first, then due time, then placement time. `PUT /api/orders/:id/priority`. (`utils/kitchenPriority.js`, `lib/kitchenSort.js`)
- **Configurable deduction point**, `INVENTORY_DEDUCT_AT=preparing|accepted`. Cancel from Accepted restocks only when deducted at acceptance. (`utils/inventoryPlan.js`)
- **Low-stock warnings and acknowledgement** in the inventory panel. (`GET /api/inventory/low-stock`, `POST /api/inventory/low-stock/ack`)
- **Staff sold-out marking** through `PUT /api/food/:id` (`available`, `soldOutUntil`). Staff still cannot change stock.
- **Menu management**: subcategory, tags (up to 10), meal periods with configurable windows, scheduled availability (`servesFrom`, `servesUntil`), temporary sold-out, sale price with end date, variants such as Half and Full (up to 6), prep time (0–240 minutes). Filters `?subcategory=` and `?period=`. `GET /api/food` adds `menuStatus`. (`utils/menuSchedule.js`, `routes/food.js`, `utils/discovery.js`)
- **Menu image uploads**, `POST /api/food/:id/image`. JPEG, PNG and WebP only, checked by magic bytes. SVG refused. Random file names. Served from `/uploads`. (`utils/images.js`)
- **Staff and kitchen account management** (admin only), `routes/users.js`. Students are not listed. Cannot remove your own admin role or deactivate yourself. The last active admin cannot be demoted.
- **Admin dashboard tabs**: Overview, Orders, Menu, Inventory, Analytics, Coupons, Staff, Announcements. Admin-only tabs are hidden from staff.
- **Frontend API base** defaults to a relative base. The Vite proxy forwards `/api` and `/uploads`. `VITE_API_URL` may be empty.

### Bugs fixed
- None in this pass. New validation: a sale price must be below the regular price, and a sale end date needs a sale price (both 400).

### Migrations introduced
- Additive only. New optional fields on `FoodItem` (`subcategory`, `menuPeriods`, `servesFrom`, `servesUntil`, `soldOutUntil`, `salePrice`, `saleEndsAt`, `variants`, `tags`), on `Order` (`priority`, default `normal`), and on `User` (`kitchen` role). `InventoryMovement` gains type `restock`. Existing documents read as before.
- No data is rewritten.

### Tests and checks performed

| Check | Command | Result |
|---|---|---|
| Backend pure suites | `node --test` on analytics, csv, images, inventoryPlan, kitchenPriority, menuSchedule, kitchenRole, lifecycleMatrix, studentPricing, studentPure, notificationPlan, kitchenQueue, sessionRules | **Pass.** 13, 6, 8, 8, 7, 15, 6, 406, 17, 13, 16, 12, 14 respectively. |
| App loads | `require('./app')()` | Pass. `routes/users.js` and `routes/analytics.js` load. |
| Backend full suite | `npm test` | **820 tests: 568 pass, 252 fail.** All failures are DB-backed suites. `MongoMemoryServer` cannot download a MongoDB binary because `fastdl.mongodb.org` is not reachable from the sandbox. They are not code results, and the DB-backed suites for this work were **not executed**. |
| Frontend unit tests | `npm run test:unit` | **71 / 71 pass.** Includes `analytics.test.js` and the new `kitchenAndMeals.test.js` (run in UTC, Asia/Calcutta and America/New_York). |
| Frontend lint | `npx eslint src` | **0 errors, 3 warnings.** All three are in `App.jsx` and `InventoryPanel.jsx` and predate this change. |
| Frontend build | `npx vite build` | **Pass.** |
| Browser | — | **Not performed.** The admin tabs, kitchen screen, photo upload and CSV download have not been clicked in a browser. |

### Known limitations
- Analytics are computed on request, with no pre-aggregation.
- Ingredient-level inventory is deferred.
- Kitchen priority is not a lifecycle transition and writes no status-history entry.
- Staff sold-out marking is allowed. This is the current behaviour and is listed as an owner decision in PLAN.md.

### Fixes from the first database-backed run (Windows, Node 24)
- `POST /api/reviews` returned 500: Mongoose 9 needs `updatePipeline: true` for the pipeline-style rating update. Fixed in `routes/reviews.js`.
- A replayed inventory reservation looped inside a transaction until the 120 s limit. `claimOperation` now checks for an existing ledger row before inserting, so a replay writes nothing. Fixed in `services/inventory.js`.
- `test/kitchenRole.test.js` and `test/studentCheckout.test.js` failed when run without `JWT_SECRET` set. They now set a test-only secret, as `helpers.js` does.
- Test expectations corrected: the kitchen feed refusal message (`access only`), and one notification per status change for the opted-in student.
- Not re-run against MongoDB in this sandbox. Re-run `npm test` to confirm.
