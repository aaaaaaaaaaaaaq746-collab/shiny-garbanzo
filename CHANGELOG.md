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
