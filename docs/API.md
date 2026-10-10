# API reference — Orders and order lifecycle

Base path: `/api`. All responses are JSON. Errors use the shape
`{ "message": string, "details"?: object }`.

Authentication: `Authorization: Bearer <JWT>` (a bare token is also accepted for
backward compatibility). The full route list is in `docs/AUDIT.md` §2.2.

This document covers the order endpoints (Phase 2) and, in §7, the auth, food
and inventory behaviour changed by the fix-all pass before Phase 3.

---

## 1. Order statuses

Stored values (these strings are persisted and must not be renamed):

| Status | Meaning | Terminal |
|---|---|---|
| `Pending` | Placed; awaiting the canteen | no |
| `Accepted` | Accepted by staff/admin | no |
| `Preparing` | Cooking has started | no |
| `Ready` | Ready for pickup (the UI may label it "Ready for pickup") | no |
| `Completed` | Collected | yes |
| `Cancelled` | Cancelled by the student, staff or admin | yes |
| `Rejected` | Rejected by an administrator before preparation | yes |

Canonical forward path: `Pending → Accepted → Preparing → Ready → Completed`.

`Cancelled` and `Rejected` are reachable from the stages shown in §2.

## 2. Transition rules

Source of truth: `backend/utils/orderLifecycle.js`. The same rules are used by
the server to validate requests and by the API to report `allowedTransitions`
and `canCancel`, so the UI cannot offer an action the server would refuse.

### 2.1 Default mode (`ORDER_STRICT_LIFECYCLE=false`, the default)

Staff and admins may skip ahead along the forward path, preserving the original
admin workflow (Pending → Preparing, Pending → Completed).

| Role | From | Permitted targets |
|---|---|---|
| admin | Pending | Accepted, Preparing, Ready, Completed, Cancelled, Rejected |
| admin | Accepted | Preparing, Ready, Completed, Cancelled, Rejected |
| admin | Preparing | Ready, Completed, Cancelled (explicit exception) |
| admin | Ready | Completed, Cancelled (explicit exception) |
| staff | Pending | Accepted, Preparing, Ready, Completed, Cancelled |
| staff | Accepted | Preparing, Ready, Completed, Cancelled |
| staff | Preparing | Ready, Completed |
| staff | Ready | Completed |
| student | Pending | Cancelled (own order only) |
| student | Accepted | Cancelled (own order only) |

Nobody may move an order backwards. Nobody may leave `Completed`, `Cancelled` or `Rejected`.

### 2.2 Strict mode (`ORDER_STRICT_LIFECYCLE=true`)

Every adjacent stage is required. Cancel and reject rules are unchanged.

| Role | From | Permitted targets |
|---|---|---|
| admin | Pending | Accepted, Cancelled, Rejected |
| admin | Accepted | Preparing, Cancelled, Rejected |
| admin | Preparing | Ready, Cancelled |
| admin | Ready | Completed, Cancelled |
| staff | Pending | Accepted, Cancelled |
| staff | Accepted | Preparing, Cancelled |
| staff | Preparing | Ready |
| staff | Ready | Completed |
| student | Pending / Accepted | Cancelled (own order only) |

### 2.3 Reasons

| Outcome | Who | Reason |
|---|---|---|
| Cancelled | admin, staff | **required** (max 300 characters) |
| Cancelled | student | optional |
| Rejected | admin | **required** |

A missing required reason returns `400`.

## 3. Endpoints

### `POST /api/orders` — place an order
Auth: any signed-in user.

Request: `{ "items": [{ "food": "<id>", "quantity": 1..20 }], "pickupSlot"?: string, "notes"?: string }`.
Prices and totals are computed on the server from the database; client-supplied
prices, names and totals are ignored.

Response `201`: the order, plus `canCancel`. `allowedTransitions` is included for staff/admin viewers.

### `GET /api/orders` — the caller's own orders
Auth: any signed-in user. Response `200`: array of orders.

### `GET /api/orders/all` — all orders (staff/admin)
Auth: staff or admin. Optional `?status=<status>` (validated against §1; unknown value → `400`).

### `GET /api/orders/kitchen` — live queue (staff/admin)
Returns orders in `Pending`, `Accepted`, `Preparing` or `Ready`, oldest first, each with `waitSeconds` and `allowedTransitions`.

### `GET /api/orders/:id` — one order
Auth: the owning student, or staff/admin. Another student's order → `403`. Malformed id → `400`. Not found → `404`.

### `PUT /api/orders/:id/status` — change status (staff/admin)
Request: `{ "status": "<status>", "reason"?: string }`.

- The target must be a known status (`400` otherwise).
- The transition must be permitted for the caller's role and the current state (§2). Refusals: `403` (role not allowed) or `409` (state does not allow it).
- A required reason that is missing → `400`.
- The state is checked again inside the database write (`{ _id, status: <expected> }`). If another request changed the order first, the response is `409` with a message such as `Order changed to Accepted before this update could be applied`. The winning change is kept.
- **Pending inventory work first.** If an earlier request committed a status change but its inventory step failed, the order carries `inventoryPendingKind` (§4). This request completes that work before doing anything else. If the requested status equals the current status and pending work was just completed, the response is `200` (the retry succeeded). Otherwise the normal rules apply, so a repeat of an already-applied status with no pending work is still `409`.

Response `200`: the updated order.

### `POST /api/orders/:id/cancel` — cancel an order
Auth: the owning student, or staff/admin.
Request: `{}`, or `{ "reason": string }` (required for staff and admin).

| Case | Response |
|---|---|
| Student cancels own Pending/Accepted order | `200`, status `Cancelled` |
| Repeat cancel of an already-cancelled order by the same caller | `200`, unchanged (idempotent; no second audit entry) |
| Student cancels another student's order | `403` |
| Student cancels after preparation has started (Preparing/Ready) | `409` |
| Student cancels a Completed or Rejected order | `409` |
| Staff cancels Preparing/Ready | `409` (only admin may) |
| Admin cancels Preparing/Ready | `200` (explicit exception) |
| Malformed id | `400` |
| Unknown id | `404` |
| Concurrent change won by someone else | `409` |

Response `200`: the updated order. Cancellation releases any stock reservation
for orders that had not yet started preparation (see the inventory notes below).

Pending inventory work is completed first. If a previous cancel committed but its
release failed, the retry of that cancel returns `200` once the release succeeds.

## 4. Order document fields relevant to the lifecycle

| Field | Notes |
|---|---|
| `status` | Current status (§1). |
| `statusHistory[]` | Audit trail. Each successful transition appends `{ status (new), from (previous), at, by (actor id), role (actor role), reason }`. Entries written before Phase 2 have `from`, `role` and `reason` set to `null`. |
| `statusHistoryTotal` | Exact count of transitions. The array is capped at `ORDER_STATUS_HISTORY_LIMIT` (default 100), so the array may be shorter than this count. |
| `cancelledAt`, `completedAt` | Set on the matching transition. |
| `canCancel` (response only) | `true` when the viewer may cancel this order now. Drives the student "Cancel Order" button. |
| `allowedTransitions` (response only) | Staff/admin viewers only. Targets permitted for this role from the current state. |
| `inventoryPendingKind` | `null`, `"consume"` or `"release"`. Inventory work still owed for the current status. Set in the same write as the status change that needs it, and cleared after the work succeeds. Normally `null`. Documents written before this field existed read as `null`. |
| `inventoryPendingReason` | Reason passed to the pending release (for the ledger), or `null`. |

Failed requests never append to `statusHistory`. The append happens in the same
database write as the status change.

## 5. Inventory side effects of transitions

These apply only when the item is inventory-tracked. Items without tracking are unaffected.

- Moving to `Cancelled` or `Rejected` from `Pending` or `Accepted` releases the reservation.
- Moving to `Preparing`, `Ready` or `Completed` consumes the reservation (stock goes down).
- Cancelling from `Preparing` or `Ready` (admin exception) does **not** restore stock, because the food has already been prepared. Restoring it needs a separate, authorized stock adjustment.

Inventory effects run after the status change is committed. Each counter change
first claims its ledger row (unique `operationId`), then changes the counters
with a guarded update, then records the result. Concurrent or repeated requests
therefore apply a movement at most once. If the inventory step fails, the order
keeps `inventoryPendingKind` and the next status-changing request for that order
completes it (§4). On a standalone MongoDB, a crash between claim and counter
change leaves that movement unapplied, not doubled. See `PLAN.md`.

## 6. Compatibility

- No existing route, field or status value was removed or renamed.
- Every field added by the lifecycle has a default, so existing documents load unchanged.
- Responses keep `status`, `items`, `total` and `statusHistory` in their original shape.

---

## 7. Auth, food stock and inventory changes (fix-all pass)

### 7.1 Authentication (applies to every authenticated route and to the socket handshake)

A token is accepted only if all of the following hold. Failures return `401`:

| Condition | `message` |
| --- | --- |
| No token | `No authentication token provided` |
| Bad signature or malformed | `Invalid authentication token` |
| Expired | `Session expired, please log in again` |
| Account deleted | `Account no longer exists` |
| Account deactivated (`isActive: false`) | `This account has been deactivated` |
| Token revoked by logout | `Session has ended, please log in again` |

Tokens issued before this change have no revocation claim. They are treated as
version 0 and keep working until the account logs out.

Socket.IO (`io` handshake): the same rules apply. Refusals reach the client as a
`connect_error` with one of: `Authentication required`, `Session expired`,
`Account no longer exists`, `Account deactivated`, `Session has ended`, or
`Invalid token`.

### 7.2 `POST /api/auth/logout`

Response is unchanged (`200`, `{ message, tokenDiscardedAt }`). Behaviour changed:
the account's token version is incremented, so **every session for that account
stops working on every device**, not only the one that logged out. The client
should still discard its stored token. Signing in again issues a working token.

### 7.3 Food stock (`/api/food`)

| Request | Result |
| --- | --- |
| Staff `PUT /:id` with `stock` | `403` "Only administrators can change stock levels". Nothing is written. |
| Staff `PUT /:id` with other menu fields | `200` (unchanged). |
| Admin `PUT /:id` with `stock` on an **inventory-tracked** item | `400`. Use `POST /api/inventory/:id/adjust`. Nothing is written. |
| Admin `PUT /:id` with `stock` on an untracked item | `200` (legacy behaviour, unchanged). |
| `DELETE /:id` while `reserved > 0` on a tracked item | `409` "Cannot delete … while N unit(s) are reserved for open orders". |
| Staff `POST /` with any of `trackInventory`, `stock`, `lowStockThreshold`, `unit` | `403`. |
| Admin `POST /` with `trackInventory: true` and `stock` | `201`. The starting stock is recorded in the inventory ledger. |
| Admin `POST /` with `trackInventory: true` and no `stock` | `400` "stock is required when trackInventory is true". |
| Admin `POST /` with `stock` and no `trackInventory` | `400`. |
| Admin `POST /` with `lowStockThreshold` / `unit` | Stored (admin only). |

### 7.4 Manual stock adjustment (`POST /api/inventory/:foodId/adjust`, admin)

Body: `{ "reason": string, "delta": integer }` **or** `{ "reason": string, "set": integer ≥ 0 }`.

- `set` is an absolute target. The server reads the current stock and computes the change itself. The client never sends a delta for `set`.
- The change is applied only if stock is still the value it was computed from. If another write changed it first, the response is `409` with `code` `CONCURRENT_UPDATE` (message "Stock changed while this adjustment was being saved. Reload and try again."). Nothing is applied from the losing request. Retrying is safe.
- `set` equal to the current stock → `400` "Stock is already at that value".
- Stock below zero → `400` "Stock cannot be reduced below zero".
- Item not tracked → `400`.

Every applied adjustment is written to the ledger (`type: "adjustment"`).

### 7.5 Enabling tracking (`POST /api/inventory/:foodId/tracking`)

The ledger row records the difference between the old and new stock figures, so
the ledger explains the change. Repeating the request with a new stock value
records only the difference.

## 8. Student experience (Phase 1 of the feature spec)

All routes need a bearer token unless marked public. Money fields are rupees.
Errors use the standard body `{ message, ... }`. Validation errors are 400,
ownership failures are 403, missing resources are 404, and state conflicts
(closed slot, sold out, used-up coupon, already reviewed) are 409.

### 8.1 Menu discovery: `GET /api/food` (public)

With no parameters the response is the full menu array, as before. Each item now
also has `badges: { featured, bestselling, isNew }`.

| Query | Meaning |
|---|---|
| `search` (or `q`) | Matches name, description or category. Case-insensitive. Max 100 characters. |
| `category` | Exact category. |
| `dietary` | Exact value: `veg`, `non-veg`, `vegan`, `jain`, `egg`. Other values are 400. |
| `veg` | `veg` (veg, vegan, jain) or `nonveg` (non-veg, egg). Other values are 400. |
| `minPrice`, `maxPrice` | Numbers from 0 to 100000. `minPrice` above `maxPrice` is 400. |
| `available` | `true` or `false`. |
| `featured` | `true` returns featured items only. |
| `sort` | `name`, `name_desc`, `price_asc`, `price_desc`, `newest`, `popularity` (most ordered), `rating` (top rated). Other values are 400. |

Bestseller badges are computed over the whole menu: the top
`BESTSELLER_COUNT` (default 5) items by units ordered. Items never ordered are
not bestsellers. The New badge covers items created in the last
`NEW_ITEM_DAYS` (default 7).

`GET /api/food/:id` (public) returns one item with its badges. `GET /api/food/categories`
is unchanged.

Admin or staff may set on `POST /api/food` and `PUT /api/food/:id`:
`dietary` (one of `veg`, `non-veg`, `vegan`, `jain`, `egg`; `null` or `""` clears it,
any other value is a 400), `featured` (boolean), `addOns` (up to 10 of
`{ label, price }`, labels unique, price 0 to 1000), `ingredients` and `allergens`
(up to 30 short strings each).
Stock fields remain admin-only, as in section 7.

### 8.2 Price a cart: `POST /api/orders/quote`

Body: `{ items, couponCode?, pickupAt? }`, where each item is
`{ food, quantity, addOns?, specialInstructions? }`. `addOns` is a list of
add-on labels defined on the menu item.

Returns `200`:

```json
{
  "lines": [{ "food": "…", "name": "Dosa", "basePrice": 50, "addOns": [{ "label": "Extra chutney", "price": 5 }], "unitPrice": 55, "quantity": 2, "lineTotal": 110, "specialInstructions": null }],
  "bill": { "subtotal": 110, "discount": 11, "couponCode": "OFF10", "charges": [{ "label": "Packaging", "amount": 4 }, { "label": "Tax (5%)", "amount": 4.95 }], "total": 107.95, "itemCount": 2 },
  "pickupAt": null,
  "estimatedPrepMinutes": 10
}
```

Nothing is written and no stock is reserved. The bill is computed by the same
code as `POST /api/orders`, so the two totals match. Prices never come from the
client.

Errors: 400 for an unknown add-on, a missing item, a bad coupon, or a bad
pickup format. 409 for an unavailable or sold-out item, or a pickup time that is
not an open slot.

### 8.3 Pickup slots: `GET /api/orders/slots`

Optional `foods=<id>,<id>,…` (up to 50). The server looks up their prep times and
uses the longest one. Example:

```json
{
  "name": "College Canteen",
  "utcOffsetMinutes": 330,
  "slotMinutes": 15,
  "estimatedPrepMinutes": 10,
  "earliestReadyAt": "2026-10-10T04:15:00.000Z",
  "slots": [{ "at": "2026-10-10T04:30:00.000Z", "label": "2026-10-10 10:00" }]
}
```

Slots are on a 15-minute grid in canteen-local time (`CANTEEN_UTC_OFFSET_MINUTES`,
default 330 for IST). They run from `CANTEEN_OPEN_HOUR` (9) to
`CANTEEN_CLOSE_HOUR` (18) across `PICKUP_SLOT_DAYS` (2) days. They start no
earlier than the earliest ready time, which is the longest prep time plus
`PREP_BUFFER_MINUTES` (5).

### 8.4 Place an order: `POST /api/orders`

Body: `{ items, pickupAt?, couponCode?, pickupSlot?, notes? }`. Each item takes
`{ food, quantity, addOns?, specialInstructions? }`. `specialInstructions` is at
most 140 characters. `pickupAt` must be an open slot from 8.3. Omit it for "as
soon as ready".

Returns `201` with the order. New fields: `subtotal`, `discount`, `charges`,
`couponCode`, `pickupAt`. Items gain `basePrice`, `addOns` and
`specialInstructions`. Here `price` is the unit price **including** add-ons,
so `price x quantity` equals the line total.

A coupon is claimed atomically before the order is written. If the order cannot
be stored or stock cannot be reserved, the claim is released. The order's
`orderCount` counters are updated after stock is reserved. A failed order
updates no counter.

Errors: 409 for a sold-out or unavailable item, a fully used coupon, or a closed
pickup time. 400 for an unknown coupon or add-on, or for instructions over 140 characters.

### 8.5 Receipt: `GET /api/orders/:id/receipt`

Owner or staff only (403 for another student, 404 if missing). Returns
`text/plain; charset=utf-8` with `Content-Disposition: inline`. The receipt
shows the stored `paymentStatus` as recorded. No payment or refund is created.

### 8.6 Reviews

| Method and path | Auth | Purpose |
|---|---|---|
| `POST /api/reviews` | Owner | Body `{ orderId, foodId, rating (1-5 integer), comment? (max 500) }`. Allowed only when the order is `Completed`, the item is in that order, and the item is not already reviewed for that order. Returns 201. |
| `GET /api/reviews/food/:foodId` | Public | `{ average, count, reviews: [{ id, rating, comment, createdAt }] }`, newest first, up to 50. No reviewer identity. |
| `GET /api/reviews/order/:orderId` | Owner | The student's reviews for one order: `[{ foodId, rating, comment }]`. |

Errors: 403 when the caller does not own the order, 409 when the order is not
Completed or the item is already reviewed, 400 for an item not in the order.
The item's `ratingAverage` and `ratingCount` update in one atomic write. A unique
index on `(order, food)` also stops a double submit.

### 8.7 Coupons (admin only)

| Method and path | Purpose |
|---|---|
| `GET /api/coupons` | List all coupons. |
| `POST /api/coupons` | Body `{ code, type: "percent"|"flat", value, minSubtotal?, maxDiscount?, expiresAt?, usageLimit?, active? }`. Codes are stored upper-case, 3 to 40 letters, digits, `-` or `_`. Duplicate code: 409. A percentage above 100 is 400. |
| `PATCH /api/coupons/:id` | Body `{ active?, expiresAt?, usageLimit? }`. A usage limit cannot go below the number already used. |

Students use a code by passing `couponCode` to 8.2 or 8.4. Students who call a
route here get 403.

### 8.8 Account

- `PUT /api/auth/me`: now also accepts `phone`. Digits, spaces, dashes, brackets
  and a leading `+`; 7 to 15 digits; `null` or `""` clears it. Also accepts
  `name` and `notificationPrefs` (`orderUpdates`, `promotions`, `sound`).
- `GET /api/auth/me` returns `phone` and `notificationPrefs` as well.
- `POST /api/auth/me/password` (rate limited): body
  `{ currentPassword, newPassword }`. A wrong current password is 400 (not 401,
  so the client does not treat it as an expired session). A new password must be
  at least 8 characters and different from the current one. On success the
  account's `tokenVersion` is incremented, so **every other session stops
  working**. The response is `{ message, token }`; the new token replaces the
  old one on this device.

### 8.9 Order history filters: `GET /api/orders`

Optional query parameters, applied to the caller's own orders:

| Parameter | Meaning |
|---|---|
| `status` | One or more statuses, comma-separated. Unknown values are 400. |
| `from`, `to` | `YYYY-MM-DD`, UTC, inclusive. `from` after `to` is 400. |
| `limit` | 1 to 500. Omitted means no limit. |

With no parameters the response is the full history, newest first, as before.

### 8.10 Compatibility

- Existing routes, response fields and status values are unchanged. New fields
  are additive.
- Order items written before this change have no `basePrice`, `addOns` or
  `specialInstructions`. Consumers should treat them as absent.
- Existing order totals are unchanged. For a cart with no coupon and no charges,
  `total` still equals `subtotal`.
- `GET /api/food?dietary=` now rejects values outside `veg`, `non-veg`, `vegan`,
  `jain`, `egg` with 400. Previously any string was accepted and simply matched nothing.
- `GET /api/food?sort=` keeps the same keys and 400 for unknown keys. Default order is unchanged.
