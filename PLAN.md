# Project plan and status

This file is the running status of the College Canteen enhancement work.
The detailed audit and milestone plan is in `docs/AUDIT.md` (sections 4, 7 and 8).
Per-change history is in `CHANGELOG.md`. The HTTP contract is in `docs/API.md`.

Status key: **Done** (in the repo and verified as stated), **Done, unverified**
(in the repo, but its database tests could not be executed in this environment),
**Partial**, **Open**.

## Phases

| Phase | Scope | Status | Evidence |
|---|---|---|---|
| 0 | Audit, baseline, prioritized plan | **Done** | `docs/AUDIT.md`, commit `d638b83` |
| 1 | Security and stability hardening (M1) | **Done, unverified (DB)** | Items N1, N2 and N7 were open before this pass and are now fixed. See the Phase 1 table. |
| 2 | Order lifecycle state machine and student cancellation | **Done, unverified (DB)** | See the Phase 2 table. Pure tests pass; DB tests are written but not executed here. |
| 2.5 | Fix-all pass before Phase 3 (P2-R1, P2-R2, P1-N1/N2/N7/N13, P0-N9 to N12, N3 to N6) | **Done, unverified (DB)** | See the Fix-all table. |
| 1-SX | Student experience (feature spec Phase 1): discovery, cart and checkout, tracking, account | **Done, unverified (DB and browser)** | See the Student-experience table below. Pure tests, frontend unit tests, build and SSR render pass. DB tests and browser checks were not run. |
| 3+ | Analytics and exports, payments, QR, PWA, recommendations | **Open** | Milestones M2–M8 in `docs/AUDIT.md` §7. Payments, QR and PWA scope need decisions (§8). Menu/cart UX, receipts, coupons and reviews were delivered under 1-SX. |

### Phase 1 — status detail

Reported complete by the project owner. The repository did not bear this out for two
High-severity items (N1, N2). Both are now fixed in this pass, but the owner should
know that the earlier "complete" claim was wrong.

| Item | Status | Notes |
|---|---|---|
| Public signup cannot create admins | Done | `routes/auth.js` forces `role: "student"`. |
| Server-side order totals | Done | `routes/order.js` uses database prices. |
| `GET /api/auth/me` for session restore | Done | |
| Expired token, logout, missing user | **Done** | Logout now revokes the account's tokens (see P1-N13). |
| Deactivated accounts blocked on REST (N1) | **Done, unverified (DB)** | `authMiddleware` and `optionalAuthMiddleware` now refuse `isActive === false` with 401. Unit tests pass; the HTTP test needs MongoDB. |
| Staff cannot change physical stock (N2) | **Done, unverified (DB)** | Staff get 403 on `stock`. Admin `PUT stock` on a tracked item gets 400 and must use the ledger endpoint. Untracked items keep the legacy cap. |
| Centralized errors, auth rate limiting, env-based API URL | Done | |
| Frontend build | Done | Verified in this environment. |
| Backend tests | **Partly verified** | Pure tests pass (322 with the session unit tests). DB tests need a MongoDB binary; see Environment below. |
| ESLint configuration (P0-N9) | **Done** | Flat config. `npx eslint .`: 0 errors, 4 warnings (`set-state-in-effect`, deliberately kept as warnings). |

### Phase 2 — status detail

| Requirement | Status | Evidence |
|---|---|---|
| Central, explicit transition map | Done | `backend/utils/orderLifecycle.js`. |
| Invalid transitions rejected on the server; status from the client is not trusted | Done | `checkTransition` is called in `PUT /:id/status` and `POST /:id/cancel`. |
| Existing statuses preserved (`Preparing`, `Completed`, `Ready`) | Done | Stored values unchanged. The UI may show "Ready for pickup" as a label. |
| Student cancels own Pending/Accepted only | Done | Ownership and state checked; `CANCELLABLE_BY`. |
| Cancel after prep starts refused (admin exception only) | Done | Admin may cancel Preparing/Ready. Staff and students may not. |
| Repeated cancel is idempotent | Done | Same-owner repeat returns 200 with no second audit entry. |
| Staff/admin role boundaries; reasons required for staff/admin cancel and admin reject | Done | `REASON_REQUIRED`, `REJECTABLE_BY`. Students cancel without a reason. |
| Terminal states cannot be reopened | Done | |
| Audit entry per successful transition (from, to, actor, role, time, reason) | Done | Embedded in `statusHistory`, written in the same atomic update. |
| Failed requests leave no audit entry | Done | |
| Conditional atomic update (state checked inside the write) | Done | `applyTransition` filters on `{ _id, status: expectedFrom }`. |
| Concurrency: losing request gets a conflict and the winner is kept | Done, DB tests not executed | Existing DB tests. |
| Frontend: Cancel shown only when eligible; confirmation; refresh after | Done | `StudentDashboard.jsx` uses `order.canCancel`, `window.confirm`, and replaces the order in place. Builds; SSR render verified (see below). |
| Exhaustive transition matrix (every role × state × target, both modes) | **Done, executed** | `backend/test/lifecycleMatrix.test.js`: 308 cases, all pass. |
| Route-level tests (ownership, HTTP codes, audit persistence, race) | **Done, not executed** | `test/orderLifecycle.test.js`, `test/order.test.js`, `test/integration.test.js`. Need MongoDB. |
| API documentation | Done | `docs/API.md`. |

### Fix-all table (turn 5)

| ID | Severity | Status | What changed |
|---|---|---|---|
| P2-R1 | High | **Done, unverified (DB)** | Claim-first inventory. Every counter change (reserve, release, consume, adjust, tracking) first inserts its ledger row (unique `operationId`), then changes counters with a guarded conditional update, then records the result. A refused update withdraws its claim (`abandonOperation`). On a replica set, `reserveOrder` runs in one transaction with the session passed through; the compensation loop now runs only on the standalone path. |
| P2-R2 | Medium | **Done, unverified (DB)** | Orders carry `inventoryPendingKind` (`consume`/`release`/null) and `inventoryPendingReason`. The marker is written in the same atomic write as the status change that owes the work, and cleared after the work succeeds. `PUT /:id/status` and `POST /:id/cancel` first complete any pending work. A retry of the transition that already took effect returns 200. |
| P1-N1 | High | **Done, unverified (DB)** | Deactivated accounts get 401 on REST and on the socket handshake. |
| P1-N2 | High | **Done, unverified (DB)** | See Phase 1. Frontend never calls `PUT /api/food` for stock, so the UI is unaffected. |
| P1-N7 | Low | **Done** | One `extractToken` (HTTP and socket) in `middleware/authMiddleware.js`. Realtime uses it and the shared `resolveSessionUser`. |
| P1-N13 | Medium | **Done, unverified (DB)** | `User.tokenVersion`; tokens carry `tv`; logout increments it. Logout revokes all sessions for that account. A legacy token without `tv` works until the first logout. |
| N3 | Medium | **Done, unverified (DB)** | `DELETE /api/food/:id` returns 409 while `reserved > 0` on a tracked item. |
| N4 | Medium | **Done, unverified (DB)** | `POST /api/food`: `trackInventory`, `stock`, `lowStockThreshold`, `unit` are admin-only. Starting stock is written through `setTracking`, so it is in the ledger. |
| N5 | Medium | **Done, unverified (DB)** | `adjustStock` takes `setTo` or `delta`, computes the change from the stock it read, and applies it only if stock is unchanged. A concurrent loser gets 409 `CONCURRENT_UPDATE`. |
| N6 | Low | **Done** | Removed the stray `reserved_` key from `reserveOne`; simplified the `/inventory` state filter. |
| P0-N9 | Medium | **Done** | See Phase 1. |
| P0-N10 | Low | **Done** | Removed `backend/it.txt`, `backend/st.txt`, `backend/tap.txt`, `frontend/pw.txt`, `frontend/pw2.txt`. `a.html` kept, as the owner asked. |
| P0-N11 | Medium | **Partly done** | Docs say how to run with `MONGOMS_SYSTEM_BINARY`. This sandbox still cannot run DB tests (no Linux `mongod` available). |
| P0-N12 | Low | **Done** | Root `README.md` setup guide. |

### Defects found while verifying (not in the original audit)

| ID | Severity | Status | Detail |
|---|---|---|---|
| D1 | **High** | **Fixed** | `frontend/src/components/StudentDashboard.jsx` (introduced in `d63395e`) referenced `refreshFoods` in a dependency array before it was defined. It threw `ReferenceError` on every render, so the student dashboard could not render. The Vite build did not catch this. Confirmed by server-rendering the committed file (`RENDER FAILED: ReferenceError refreshFoods is not defined`) and the fixed file (renders). Also fixed: a `useCallback` nested inside an effect (a rules-of-hooks violation) and a stale `cart` closure in `addToCart`. |
| D2 | Medium | **Fixed** | `reserveOrder` could compensate lines already rolled back by a transaction, and could double-count attempts when a transaction is retried. Compensation is now standalone-only, and each attempt starts from empty state. |
| D3 | Medium | **Fixed** | `transactionsSupported()` cached `false` if called before the connection existed. It is no longer cached. |
| D4 | Low | **Fixed** | `setTracking` changed stock without a matching ledger delta. The tracking row now records the difference. |
| D5 | Low | **Fixed** | `POST /api/food` with `trackInventory` now deletes the item if the starting-stock step fails, so no half-configured item is left. |

## Verification (this environment, turn 5)

| Check | Result |
|---|---|
| `npx eslint .` (frontend) | Pass: 0 errors, 4 warnings (rule intentionally set to warn). |
| `npm run build` (frontend) | Pass. |
| Server-render check of `StudentDashboard` (committed vs fixed) | Committed: fails with `ReferenceError`. Fixed: renders. Technique: `esbuild` bundle plus `react-dom/server`. This is a render-only check, not a browser test. |
| `node -e require` on every changed backend module | Pass. |
| `node --test test/sessionRules.test.js test/lifecycleMatrix.test.js` | **322 / 322 pass** (14 session-rule unit tests + 308 lifecycle matrix). |
| Full backend suite (`npm test`) | **551 run: 326 pass, 225 fail.** All 225 failures are `hookFailed`: the `before` hook could not start MongoDB (`fastdl.mongodb.org` download blocked, ECONNRESET). **Zero assertion failures.** Before this pass the suite had 499 tests, 312 pass, 187 fail, with the same cause. The 38 new DB-backed tests therefore have **not executed**. |
| Playwright end-to-end | Not run (needs MongoDB and a browser). |
| Browser verification | **Not performed.** |

To run the DB-backed suite, use a machine with a MongoDB binary (or internet access for the download):

```
cd backend
npm ci
MONGOMS_SYSTEM_BINARY=/path/to/mongod npm test   # or just: npm test
```

## Student experience (1-SX) status detail

| Requirement | Status | Evidence |
|---|---|---|
| Search, category, veg / non-veg, price range, availability, sort by price, popularity, rating | Done | `utils/discovery.js` (+ `studentDiscovery.test.js`); `GET /api/food`. |
| Featured, bestselling and new badges | Done | `badgesFor` / `bestsellerIdSet`; the Bestseller badge is computed over the whole menu. |
| Images, prep time, ingredients, allergens | Done | `FoodCard.jsx`; fields on `FoodItem`. Staff can now enter category, diet, prep time, featured, ingredients, allergens and add-ons, and edit existing items (`AdminDashboard.jsx`, `FoodDetailsFields.jsx`, `lib/foodForm.js`). `PUT /api/food/:id` now accepts `dietary`. |
| Quantities, saved cart | Done | `src/lib/cart.js` (+ `tests/unit/cart.test.js`). |
| Add-ons and special instructions | Done | `utils/pricing.js` `priceLine` (+ `studentPricing.test.js`). Add-on prices come from the menu. |
| Pickup slots and estimated prep | Done | `utils/pickupSlots.js`; `GET /api/orders/slots`; the server rejects off-grid and closed times (`studentCheckout.test.js`). |
| Pickup slot capacity | **Done, unverified (DB)** | `PICKUP_SLOT_CAPACITY` (default 20, 0 = unlimited). Seats are counted in `PickupSlotCount` with conditional updates (`services/pickupCapacity.js`, `utils/pickupCapacity.js`). Full slots return 409 at quote and placement and are marked `available: false`. A cancel or rejection releases the seat once. Pure seat math is tested (`notificationPlan.test.js`, last group). DB tests in `studentFeatures.test.js` are not run. |
| Itemized bill: discounts and charges | Done | `buildBill` (+ `studentPricing.test.js`); `POST /api/orders/quote`. |
| Unavailable items blocked | Done | `services/checkout.js` returns 409. Stock-tracked items are counted across all lines. |
| Status labels, timeline, timestamps, estimated wait, cancel eligibility, realtime | Done (wording); live wait **Done, unverified (DB)** | Students read "Pending confirmation" and "Ready for pickup"; the stored values are unchanged (`statusLabel` in `orderStatus.js`). The kitchen board shares the timeline and shows the same wording. The estimated wait is recalculated on placement, status change, cancel, and every `KITCHEN_ETA_REFRESH_SECONDS` (`utils/kitchenQueue.js`, `services/kitchenEta.js`). Only changes over 60 seconds are written and emitted. The model is a FIFO estimate, not a measurement (`kitchenQueue.test.js`). |
| Profile, password, favourites, reorder | Done | `PUT /api/auth/me` (phone); `POST /api/auth/me/password` (revokes other sessions); reorder merges lines. |
| Reviews after completion | Done | `routes/reviews.js` (one per item per order, unique index, atomic average). Students can read written reviews from the food card (`ReviewsToggle` in `student/FoodCard.jsx`). |
| History filters, receipts, notification preferences | Done; email and push **built, unverified against real services** | `utils/orderHistory.js`, `utils/receipt.js`, `GET /api/orders/:id/receipt`. `orderUpdates` gates the pickup alert and `sound` plays a chime (`lib/notify.js`). Email and browser push are built as an outbox with per-channel state, retries and a dispatch timer (`services/notifications.js`, `utils/notificationPlan.js`, `routes/notifications.js`). Both are opt-in per student and need server configuration. `promotions` now drives admin announcements (`POST /api/notifications/announcements`). Delivery was tested with fake transports only. No real SMTP server or push service was contacted. |
| Payments and refunds | **Not in scope** | The app records `paymentStatus` only. No money moves. See the open decisions. |

The DB-backed tests for these routes are in `backend/test/studentFeatures.test.js`.
They have not been run.

Known gaps in this phase, stated plainly: no payments or refunds; the wait
estimate is a queue model, not a measurement; the notification dispatcher runs in one
server process only; email and push were not tested against real services; the
new database-backed tests were not run in this sandbox (no MongoDB binary); the
editor and reviews toggle were checked by server-side render only, not clicked in
a browser.

## Known limitations (documented, not fixed)

- **Crash window on standalone MongoDB.** Without transactions, a claim is written before its counter change. A process crash between those two steps leaves a claim with no counter change, so that movement is never applied. This under-applies and never double-applies. Replica sets have no such window, because the claim and the counter change are one transaction. Recovery tooling is not built.
- **Logout is account-wide.** Logging out on one device ends sessions on all devices, by design of the single `tokenVersion`.
- **Inventory retry is lazy.** A pending inventory step is completed by the next status-changing request for that order (or the next cancel). It is not retried in the background, and a `GET` does not complete it.
- **Live update after a failed inventory step.** The status is committed, but the realtime event is only emitted after the inventory step succeeds, so a student's open page may show the old status until a refresh.
- **Cancel from Preparing/Ready does not restore stock.** This is unchanged. Recovery needs an explicit admin adjustment.

## Open owner decisions

1. Confirm that logout revoking every device is acceptable (`docs/API.md`).
2. Payments, QR and PWA scope (`docs/AUDIT.md` §8).
3. Whether to build background recovery for the standalone crash window.

## Next step

Run `npm test` in `backend/` on a machine that can run MongoDB. That is the only check that exercises P2-R1, P2-R2, N2 to N5, the DB-backed session tests, and `test/studentFeatures.test.js`. Then run the Playwright suite (`npm run test:e2e`) in a browser, and do a manual pass over the student screens. Report any failures before Phase 3.
