# Project plan and status

This file is the running status of the College Canteen enhancement work.
The detailed audit and milestone plan is in `docs/AUDIT.md` (sections 4, 7 and 8).
Per-change history is in `CHANGELOG.md`. The HTTP contract is in `docs/API.md`.

Status key: **Done** (in the repo and verified as stated), **Done, unverified**
(in the repo, but its tests could not be executed in this environment), **Partial**,
**Open**.

## Phases

| Phase | Scope | Status | Evidence |
|---|---|---|---|
| 0 | Audit, baseline, prioritized plan | **Done** | `docs/AUDIT.md`, commit `d638b83` |
| 1 | Security and stability hardening (plan milestone M1) | **Partial / needs re-verification** | See the Phase 1 section below. The project owner reported it complete. Two High-severity items from the audit are still present in the code. |
| 2 | Order lifecycle state machine and student cancellation | **Done, partly unverified** | See the Phase 2 section below. |
| 3+ | Menu/cart UX, tracking/receipts, analytics and exports, coupons, reviews, payments, QR, PWA, recommendations | **Open** | Milestones M2–M8 in `docs/AUDIT.md` §7. Payments, QR and PWA scope need decisions (§8). |

### Phase 1 — status detail

Reported complete by the project owner. The repository does not fully bear this out.

| Item | Status | Notes |
|---|---|---|
| Public signup cannot create admins | Done | `routes/auth.js` forces `role: "student"`. |
| Server-side order totals | Done | `routes/order.js` uses database prices. |
| `GET /api/auth/me` for session restore | Done | |
| Expired token, logout, missing user | Partial | Expired and missing user return 401. Logout is stateless. |
| Deactivated accounts blocked on REST (audit N1) | **Open** | `authMiddleware` never checks `isActive`. The login and socket paths do. |
| Staff cannot change physical stock (audit N2) | **Open** | `PUT /api/food/:id` lets staff set `stock`, bypassing the admin-only inventory rule and the ledger. |
| Centralized errors, auth rate limiting, env-based API URL | Done | |
| Frontend build | Done | Verified in this environment. |
| Backend tests | **Not verified here** | Need an in-memory MongoDB binary; see Environment below. |
| ESLint configuration | **Open** | `eslint.config.js` imports packages not in `package.json`. |

### Phase 2 — status detail

The lifecycle map, role matrix, ownership check, atomic conditional transitions,
audit history and student cancellation were already implemented in the repo
before this phase started. They were not previously documented in `CHANGELOG.md`
or an API reference. This phase verifies them and documents them.

| Requirement | Status | Evidence |
|---|---|---|
| Central, explicit transition map | Done | `backend/utils/orderLifecycle.js`. |
| Invalid transitions rejected on the server; status from the client is not trusted | Done | `checkTransition` is called in `PUT /:id/status` and `POST /:id/cancel`. |
| Existing statuses preserved (`Preparing`, `Completed`, `Ready`) | Done | Stored values unchanged. The UI may show "Ready for pickup" as a label. |
| Student cancels own Pending/Accepted only | Done | Ownership and state checked; `CANCELLABLE_BY`. |
| Cancel after prep starts refused (admin exception only) | Done | Admin may cancel Preparing/Ready. Staff and students may not. |
| Repeated cancel is idempotent | Done | Same-owner repeat returns 200 with no second audit entry. |
| Staff/admin role boundaries; reasons required for admin cancel/reject | Done | `REASON_REQUIRED`, `REJECTABLE_BY`. |
| Terminal states cannot be reopened | Done | |
| Audit entry per successful transition (from, to, actor, role, time, reason) | Done | Embedded in `statusHistory`, written in the same atomic update. |
| Failed requests leave no audit entry | Done | |
| Conditional atomic update (state checked inside the write) | Done | `applyTransition` filters on `{ _id, status: expectedFrom }`. |
| Concurrency: losing request gets a conflict and the winner is kept | Done, tests not executed | Existing DB tests. |
| Frontend: Cancel shown only when eligible; confirmation; refresh after | Done | `StudentDashboard.jsx` uses `order.canCancel`, `window.confirm`, and replaces the order in place. |
| Exhaustive transition matrix (every role × state × target, both modes) | **Done, executed** | `backend/test/lifecycleMatrix.test.js`: 308 cases, all pass. |
| Route-level tests (ownership, HTTP codes, audit persistence, race) | **Done, not executed** | `test/orderLifecycle.test.js`, `test/order.test.js`, `test/integration.test.js`. Need MongoDB. |
| API documentation | Done | `docs/API.md`. |
| **P2-R1: inventory side effects not idempotent under concurrency** | **Open** | See Open items. |

## Open items

| ID | Severity | Item |
|---|---|---|
| P2-R1 | **High** | `services/inventory.js`: `reserveOne`, `consumeOrder` and `releaseOrder` read the ledger, then change the counters, and only then insert the ledger row (`claimOperation`). A duplicate insert fails on the unique index, but the counter change has already happened. Two concurrent movements for the same operation can therefore both change the counters. Reachable when two transitions of the same order run close together (for example two admin tabs) and the item has other reservations. Fix: claim the ledger row first, change the counters only if the claim succeeds, and remove the row if the counter change fails (`abandonOperation` already exists). Needs database tests before it is merged. |
| P2-R2 | Medium | Inventory effects run after the status change commits. If they fail, the order's status is correct but its reservation is not released or consumed, and a retry is refused by the state machine (for example a repeat cancel returns 200 without re-running release). Fix alongside P2-R1 by making the inventory step retryable. |
| P1-N1 | **High** | Deactivated accounts keep REST access until their token expires. (Phase 1 item.) |
| P1-N2 | **High** | Staff can set physical stock through `PUT /api/food/:id`. (Phase 1 item.) |
| P0-N9 | Medium | ESLint cannot run. |
| P0-N10 | Low | Scratch files committed: `backend/it.txt`, `backend/st.txt`, `backend/tap.txt`, `frontend/pw.txt`, `frontend/pw2.txt`. Removal needs the owner's confirmation. |
| P0-N11 | Medium | Backend tests need a MongoDB binary downloaded at run time. |
| P0-N12 | Low | README setup guide is missing. |
| — | Note | `a.html` at the repo root was created at the owner's request as a placeholder. It is unrelated to the project; keep or delete (owner decision). |

## Environment (how the verification was run)

- Frontend: `npm ci`, `npm run build` — run and passing.
- Backend: `npm ci` — run and passing. `npm test` — 499 tests run; 312 pass; 187 fail. All 187 failures are the same environmental error: `mongodb-memory-server` cannot download a MongoDB binary (`fastdl.mongodb.org` unreachable from the sandbox). The 308 pure lifecycle-matrix tests were not affected and all pass.
- Not run: Playwright end-to-end tests (also need MongoDB), any browser-based check.

To run the complete backend suite on a machine with internet access:

```
cd backend
npm ci
npm test
```

Or with a local MongoDB binary, set `MONGOMS_SYSTEM_BINARY=/path/to/mongod`.

## Next step

1. Run `npm test` in `backend/` on a machine that can download MongoDB and confirm the route-level tests pass.
2. Approve the P2-R1 fix. It changes inventory core code, so I'd implement it only together with database tests I can actually run.
3. Decide the open owner questions in `docs/AUDIT.md` §8 (payments, QR, cancellation window, scratch files, `a.html`, staff stock).
