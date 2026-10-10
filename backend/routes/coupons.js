const express = require("express");
const Coupon = require("../models/Coupon");
const { authMiddleware, adminMiddleware } = require("../middleware/authMiddleware");
const ApiError = require("../utils/ApiError");
const v = require("../utils/validators");

const router = express.Router();

// Coupons are managed by administrators only. Students use a code by passing
// it to POST /api/orders/quote or POST /api/orders.

function parseCode(value) {
  const code = v.optionalString(value, { field: "code", max: 40 });
  if (!code || code.length < 3 || !/^[A-Za-z0-9_-]+$/.test(code)) {
    throw ApiError.badRequest("code must be 3-40 letters, digits, - or _");
  }
  return code.toUpperCase();
}

function parseMoneyField(value, field, { min = 0, max = 100000 } = {}) {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max) {
    throw ApiError.badRequest(`${field} must be a number from ${min} to ${max}`);
  }
  return v.roundMoney(n);
}

function parseOptionalDate(value) {
  if (value === undefined || value === null || value === "") return null;
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) throw ApiError.badRequest("expiresAt must be a valid date");
  return d;
}

router.get("/", authMiddleware, adminMiddleware, async (req, res) => {
  const coupons = await Coupon.find().sort({ createdAt: -1 });
  res.json(coupons);
});

router.post("/", authMiddleware, adminMiddleware, async (req, res) => {
  const body = v.object(req.body);
  const type = v.oneOf(body.type, ["percent", "flat"], "type");
  const value = parseMoneyField(body.value, "value", { min: 0.01 });
  if (type === "percent" && value > 100) {
    throw ApiError.badRequest("A percentage coupon cannot exceed 100");
  }
  const payload = {
    code: parseCode(body.code),
    type,
    value,
    minSubtotal: body.minSubtotal === undefined ? 0 : parseMoneyField(body.minSubtotal, "minSubtotal"),
    maxDiscount:
      body.maxDiscount === undefined || body.maxDiscount === null
        ? null
        : parseMoneyField(body.maxDiscount, "maxDiscount", { min: 0.01 }),
    expiresAt: parseOptionalDate(body.expiresAt),
    usageLimit:
      body.usageLimit === undefined || body.usageLimit === null
        ? null
        : v.quantity(body.usageLimit, { field: "usageLimit", min: 1, max: 1000000 }),
    active: body.active === undefined ? true : v.boolean(body.active, "active"),
  };
  try {
    const coupon = await Coupon.create(payload);
    res.status(201).json(coupon);
  } catch (err) {
    if (err && err.code === 11000) throw ApiError.conflict("A coupon with that code already exists");
    throw err;
  }
});

/** Change whether a coupon is active, its expiry, or its usage limit. */
router.patch("/:id", authMiddleware, adminMiddleware, async (req, res) => {
  const id = v.objectId(req.params.id, "coupon id");
  const body = v.object(req.body);
  const coupon = await Coupon.findById(id);
  if (!coupon) throw ApiError.notFound("Coupon not found");

  if (body.active !== undefined) coupon.active = v.boolean(body.active, "active");
  if (body.expiresAt !== undefined) coupon.expiresAt = parseOptionalDate(body.expiresAt);
  if (body.usageLimit !== undefined) {
    if (body.usageLimit === null) {
      coupon.usageLimit = null;
    } else {
      const limit = v.quantity(body.usageLimit, { field: "usageLimit", min: 1, max: 1000000 });
      if (limit < coupon.usedCount) {
        throw ApiError.badRequest("usageLimit cannot be below the number of times the coupon was used");
      }
      coupon.usageLimit = limit;
    }
  }
  await coupon.save();
  res.json(coupon);
});

module.exports = router;
