# Canteen ordering system

A college canteen app: students browse the menu and place orders, kitchen staff
move orders through preparation, and administrators manage the menu, stock
and users.

**Stack:** React + Vite + Tailwind (frontend) · Express 5 + Mongoose + MongoDB
(backend) · Socket.IO for live order updates.

| Path | What it is |
| --- | --- |
| `backend/` | Express API, Mongoose models, Socket.IO realtime, `node:test` suites |
| `frontend/` | React single-page app, Playwright end-to-end tests |
| `docs/API.md` | HTTP API reference (routes, roles, error codes) |
| `docs/AUDIT.md` | Audit findings and their status |
| `PLAN.md` | Phased plan and what is done |
| `CHANGELOG.md` | Per-change history |

## Prerequisites

- **Node.js 20.19 or newer** (required by Mongoose 9 and mongodb-memory-server). Tested with Node 22.
- **MongoDB.** A standalone `mongod` runs the app. Atomic multi-document
  reservations on an order use transactions, which need a **replica set**. On a
  standalone server the code falls back to compensating writes; see
  `backend/services/inventory.js`.

## Backend setup

```bash
cd backend
npm install
cp .env.example .env          # then edit .env (see below)
npm run generate:secret       # paste the value into JWT_SECRET in .env
npm start                     # API on http://localhost:5000 (nodemon)
```

Key settings in `.env` (the full list, with comments, is in `backend/.env.example`):

| Variable | Purpose |
| --- | --- |
| `MONGO_URI` | MongoDB connection string. Defaults to `mongodb://127.0.0.1:27017/canteenDB`. |
| `JWT_SECRET` | **Required.** The server will not start without it, and refuses a known-weak value in production. Never commit it. |
| `JWT_EXPIRES_IN` | Token lifetime, default `1d`. |
| `CORS_ORIGINS` | Comma-separated browser origins allowed to call the API. |
| `ORDER_STRICT_LIFECYCLE` | `false` (default) lets staff skip ahead; `true` requires every stage. |

To create the first administrator, pass the details as environment variables
for one command. Do not put a password in a file you commit:

```bash
ADMIN_EMAIL=head@college.edu ADMIN_PASSWORD='choose-a-strong-one' npm run seed:admin
```

## Frontend setup

```bash
cd frontend
npm install
npm run dev                   # http://localhost:5173
```

The dev server proxies `/api` to `http://localhost:5000` (see `vite.config.js`).
`VITE_API_URL` in `frontend/.env` overrides the backend address; see
`frontend/.env.example`. Production builds call `VITE_API_URL` directly.

Other frontend scripts:

```bash
npm run build      # production build
npm run lint       # ESLint (flat config in eslint.config.js)
npm run test:e2e   # Playwright (run `npx playwright install chromium` once)
```

## Running the tests

### Backend

```bash
cd backend
npm test
```

Most backend tests run against a real MongoDB started by
`mongodb-memory-server`. On first use that package downloads a MongoDB binary.
Some sandboxes and CI runners block that download. To use a binary you already
have, point the package at it:

```bash
MONGOMS_SYSTEM_BINARY=/path/to/mongod npm test
```

On Windows, use `set MONGOMS_SYSTEM_BINARY=C:\path\to\mongod.exe` (cmd) or
`$env:MONGOMS_SYSTEM_BINARY="C:\path\to\mongod.exe"` (PowerShell).

Tests that need a replica set (transactional reservations) start one
automatically with the same binary.

Some tests do not need a database and run anywhere:

```bash
node --test test/lifecycleMatrix.test.js test/sessionRules.test.js
```

`lifecycleMatrix.test.js` checks the order transition table. `sessionRules.test.js`
checks token, deactivation and revocation rules with the user lookup stubbed.

### Frontend

```bash
cd frontend
npm run build
npm run lint
```

## Notes for maintainers

- Order stored status `Ready` is kept for compatibility. The UI may label it
  "Ready for pickup".
- Logout revokes **every** session for that account, on every device. A new
  login issues a token for the new version. See `docs/API.md`.
- Stock on a tracked menu item changes only through the inventory endpoints
  (`/api/inventory/...`). Every change is written to the movement ledger.
- The scratch file `a.html` is intentionally kept.
