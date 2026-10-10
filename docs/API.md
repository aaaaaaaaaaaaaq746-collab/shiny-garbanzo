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

