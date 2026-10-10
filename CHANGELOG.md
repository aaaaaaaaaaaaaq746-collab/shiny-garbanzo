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
