/**
 * Exhaustive lifecycle matrix (Phase 2).
 *
 * This file needs NO database. It exercises the pure transition map in
 * utils/orderLifecycle.js against an explicit, hand-written expectation table,
 * so every (role x from-status x to-status) combination is checked, in both the
 * default (skip-ahead) mode and strict mode.
 *
 * The expectation tables below are written from the Phase 2 rules, not copied
 * from the implementation. If the implementation drifts, this file fails.
 *
 * Route-level behaviour (ownership, HTTP codes, audit persistence, concurrency)
 * is covered by orderLifecycle.test.js and integration.test.js, which need the
 * in-memory MongoDB binary.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const lifecycle = require("../utils/orderLifecycle");

const { STATUS, ORDER_STATUSES, checkTransition, allowedTransitions, canCancel } = lifecycle;

const ALL = ORDER_STATUSES;

// ---------------------------------------------------------------------------
// Expected permitted transitions. from -> [allowed to-statuses]
// ---------------------------------------------------------------------------

/** Non-strict (default, skip-ahead) mode. */
const EXPECTED_SKIP_AHEAD = {
  admin: {
    Pending: ["Accepted", "Preparing", "Ready", "Completed", "Cancelled", "Rejected"],
    Accepted: ["Preparing", "Ready", "Completed", "Cancelled", "Rejected"],
    Preparing: ["Ready", "Completed", "Cancelled"], // admin may cancel after prep starts
    Ready: ["Completed", "Cancelled"],
    Completed: [],
    Cancelled: [],
    Rejected: [],
  },
  staff: {
    Pending: ["Accepted", "Preparing", "Ready", "Completed", "Cancelled"],
    Accepted: ["Preparing", "Ready", "Completed", "Cancelled"],
    Preparing: ["Ready", "Completed"], // staff may NOT cancel once cooking
    Ready: ["Completed"],
    Completed: [],
    Cancelled: [],
    Rejected: [], // staff may never reject
  },
  student: {
    Pending: ["Cancelled"],
    Accepted: ["Cancelled"],
    Preparing: [],
    Ready: [],
    Completed: [],
    Cancelled: [],
    Rejected: [],
  },
};

/** Strict mode: every adjacent stage is required; cancel/reject rules unchanged. */
const EXPECTED_STRICT = {
  admin: {
    Pending: ["Accepted", "Cancelled", "Rejected"],
    Accepted: ["Preparing", "Cancelled", "Rejected"],
    Preparing: ["Ready", "Cancelled"],
    Ready: ["Completed", "Cancelled"],
    Completed: [],
    Cancelled: [],
    Rejected: [],
  },
  staff: {
    Pending: ["Accepted", "Cancelled"],
    Accepted: ["Preparing", "Cancelled"],
    Preparing: ["Ready"],
    Ready: ["Completed"],
    Completed: [],
    Cancelled: [],
    Rejected: [],
  },
  student: {
    Pending: ["Cancelled"],
    Accepted: ["Cancelled"],
    Preparing: [],
    Ready: [],
    Completed: [],
    Cancelled: [],
    Rejected: [],
  },
};

const ROLES = ["admin", "staff", "student"];

function permittedSet(table, role, from) {
  return new Set(table[role][from]);
}

// ---------------------------------------------------------------------------
// 1. Every permitted and forbidden transition, both modes, every role.
// ---------------------------------------------------------------------------

for (const [label, strict, table] of [
  ["skip-ahead (default)", false, EXPECTED_SKIP_AHEAD],
  ["strict", true, EXPECTED_STRICT],
]) {
  for (const role of ROLES) {
    for (const from of ALL) {
      for (const to of ALL) {
        const name = `[${label}] ${role}: ${from} -> ${to}`;
        test(name, () => {
          const expectAllowed = permittedSet(table, role, from).has(to);
          const result = checkTransition({ from, to, role, strict });

          assert.equal(
            result.allowed,
            expectAllowed,
            `expected ${expectAllowed ? "allowed" : "forbidden"}, got ${JSON.stringify(result)}`
          );

          if (!expectAllowed) {
            // Forbidden transitions must carry an HTTP status the API can surface.
            assert.ok([400, 403, 409].includes(result.code), `unexpected code ${result.code}`);
            assert.equal(typeof result.message, "string");
            assert.ok(result.message.length > 0);
          }
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Specific rules that the matrix alone does not make obvious.
// ---------------------------------------------------------------------------

test("terminal states can never be left by any role, in either mode", () => {
  for (const strict of [false, true]) {
    for (const role of ROLES) {
      for (const from of ["Completed", "Cancelled", "Rejected"]) {
        for (const to of ALL) {
          assert.equal(checkTransition({ from, to, role, strict }).allowed, false, `${role} ${from}->${to}`);
        }
      }
    }
  }
});

test("students get 403 (not 409) for any non-cancel status request", () => {
  // Pending -> Pending is excluded on purpose: the same-state check runs first
  // and returns 409 for every role (covered by the next test).
  for (const to of ["Accepted", "Preparing", "Ready", "Completed", "Rejected"]) {
    const r = checkTransition({ from: "Pending", to, role: "student" });
    assert.equal(r.code, 403, `student Pending->${to}`);
  }
});

test("only an administrator can reject; staff get 403 on Rejected", () => {
  assert.equal(checkTransition({ from: "Pending", to: "Rejected", role: "staff" }).code, 403);
  assert.equal(checkTransition({ from: "Pending", to: "Rejected", role: "student" }).code, 403);
  assert.equal(checkTransition({ from: "Pending", to: "Rejected", role: "admin" }).allowed, true);
});

test("an administrator cannot reject once preparation has started (409)", () => {
  const r = checkTransition({ from: "Preparing", to: "Rejected", role: "admin" });
  assert.equal(r.allowed, false);
  assert.equal(r.code, 409);
});

test("unknown target statuses are rejected with 400", () => {
  for (const role of ROLES) {
    const r = checkTransition({ from: "Pending", to: "Shipped", role });
    assert.equal(r.allowed, false);
    assert.equal(r.code, 400);
  }
});

test("an order in an unrecognised state is rejected with 409", () => {
  const r = checkTransition({ from: "Lost", to: "Accepted", role: "admin" });
  assert.equal(r.allowed, false);
  assert.equal(r.code, 409);
});

test("transitions to the current status are rejected with 409", () => {
  for (const s of ALL) {
    for (const role of ROLES) {
      const r = checkTransition({ from: s, to: s, role });
      assert.equal(r.allowed, false);
      assert.equal(r.code, 409);
    }
  }
});

test("no transition moves an order backwards along the forward path", () => {
  const forward = ["Pending", "Accepted", "Preparing", "Ready", "Completed"];
  for (const role of ["admin", "staff"]) {
    for (let i = 0; i < forward.length; i += 1) {
      for (let j = 0; j < i; j += 1) {
        const r = checkTransition({ from: forward[i], to: forward[j], role });
        assert.equal(r.allowed, false, `${role} ${forward[i]}->${forward[j]} must be refused`);
      }
    }
  }
});

test("a cancelled order cannot be reopened by any role", () => {
  for (const role of ROLES) {
    for (const to of ["Pending", "Accepted", "Preparing", "Ready", "Completed"]) {
      assert.equal(checkTransition({ from: "Cancelled", to, role }).allowed, false);
    }
  }
});

// ---------------------------------------------------------------------------
// 3. Derived helpers must agree with the matrix.
// ---------------------------------------------------------------------------

test("allowedTransitions() matches the expected table for every role and state", () => {
  for (const [label, strict, table] of [
    ["skip-ahead", false, EXPECTED_SKIP_AHEAD],
    ["strict", true, EXPECTED_STRICT],
  ]) {
    for (const role of ["admin", "staff"]) {
      for (const from of ALL) {
        const actual = allowedTransitions({ from, role, strict }).slice().sort();
        const expected = table[role][from].slice().sort();
        assert.deepEqual(actual, expected, `${label} ${role} from ${from}`);
      }
    }
  }
});

test("canCancel() agrees with the matrix for every role and state", () => {
  for (const role of ROLES) {
    for (const from of ALL) {
      const order = { status: from, student: "owner-id" };
      const user = role === "student" ? { role, _id: "owner-id" } : { role, _id: "someone" };
      const expected = EXPECTED_SKIP_AHEAD[role][from].includes("Cancelled");
      assert.equal(canCancel({ order, user }), expected, `${role} on ${from}`);
    }
  }
});

test("a student cannot cancel another student's order, even when the state allows it", () => {
  const order = { status: "Pending", student: "owner-id" };
  assert.equal(canCancel({ order, user: { role: "student", _id: "intruder" } }), false);
  assert.equal(canCancel({ order, user: { role: "student", _id: "owner-id" } }), true);
});

test("reasons are required for administrative cancellation and rejection only", () => {
  const { requiresReason } = lifecycle;
  assert.equal(requiresReason({ to: "Cancelled", role: "admin" }), true);
  assert.equal(requiresReason({ to: "Cancelled", role: "staff" }), true);
  assert.equal(requiresReason({ to: "Cancelled", role: "student" }), false);
  assert.equal(requiresReason({ to: "Rejected", role: "admin" }), true);
  for (const role of ROLES) {
    for (const to of ["Accepted", "Preparing", "Ready", "Completed"]) {
      assert.equal(requiresReason({ to, role }), false, `${role} -> ${to}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 4. Compatibility: the status vocabulary must not change.
// ---------------------------------------------------------------------------

test("the status vocabulary is the stored value set (no renamed or removed statuses)", () => {
  assert.deepEqual(
    [...ALL].sort(),
    ["Accepted", "Cancelled", "Completed", "Pending", "Preparing", "Ready", "Rejected"]
  );
  assert.equal(STATUS.READY, "Ready", "'Ready' is the stored value; the UI may label it 'Ready for pickup'");
  assert.equal(STATUS.PREPARING, "Preparing", "legacy status must be preserved");
  assert.equal(STATUS.COMPLETED, "Completed", "legacy status must be preserved");
});
