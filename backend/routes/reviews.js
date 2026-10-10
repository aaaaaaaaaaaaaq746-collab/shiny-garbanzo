const express = require("express");
const Order = require("../models/Order");
const Food = require("../models/FoodItem");
const Review = require("../models/Review");
const { authMiddleware } = require("../middleware/authMiddleware");
const ApiError = require("../utils/ApiError");
const v = require("../utils/validators");
const { validateRating, validateComment, assertCanReview } = require("../utils/reviews");

const router = express.Router();

/**
 * Rate one item from a completed order the student owns.
 *
 * Body: { orderId, foodId, rating (1-5), comment? }.
 * The rule checks live in utils/reviews.js. The item's rating aggregate is
 * updated in one atomic pipeline update.
 */
router.post("/", authMiddleware, async (req, res) => {
  const body = v.object(req.body);
  const orderId = v.objectId(body.orderId, "orderId");
  const foodId = v.objectId(body.foodId, "foodId");
  const rating = validateRating(body.rating);
  const comment = validateComment(body.comment);

  const order = await Order.findById(orderId);
  if (!order) throw ApiError.notFound("Order not found");

  const alreadyReviewed = await Review.exists({ order: orderId, food: foodId });
  assertCanReview({
    order,
    studentId: req.user._id,
    foodId,
    alreadyReviewed: Boolean(alreadyReviewed),
  });

  let review;
  try {
    review = await Review.create({
      order: orderId,
      food: foodId,
      student: req.user._id,
      rating,
      comment,
    });
  } catch (err) {
    // The unique (order, food) index settles a race between two submissions.
    if (err && err.code === 11000) {
      throw ApiError.conflict("You have already reviewed this item for this order");
    }
    throw err;
  }

  // Recompute the average inside the update itself, so concurrent reviews
  // cannot leave the aggregate inconsistent.
  await Food.updateOne({ _id: foodId }, [
    {
      $set: {
        ratingCount: { $add: [{ $ifNull: ["$ratingCount", 0] }, 1] },
        ratingSum: { $add: [{ $ifNull: ["$ratingSum", 0] }, rating] },
      },
    },
    { $set: { ratingAverage: { $round: [{ $divide: ["$ratingSum", "$ratingCount"] }, 2] } } },
  ], { updatePipeline: true });

  res.status(201).json({
    id: review._id.toString(),
    orderId: String(orderId),
    foodId: String(foodId),
    rating,
    comment,
    createdAt: review.createdAt,
  });
});

/**
 * Public reviews for one item, newest first, with the aggregate.
 * Student identities are never included.
 */
router.get("/food/:foodId", async (req, res) => {
  const foodId = v.objectId(req.params.foodId, "foodId");
  const food = await Food.findById(foodId, { ratingAverage: 1, ratingCount: 1 });
  if (!food) throw ApiError.notFound("Food item not found");
  const reviews = await Review.find({ food: foodId })
    .sort({ createdAt: -1 })
    .limit(50)
    .select("rating comment createdAt");
  res.json({
    average: food.ratingAverage ?? 0,
    count: food.ratingCount ?? 0,
    reviews: reviews.map((r) => ({
      id: r._id.toString(),
      rating: r.rating,
      comment: r.comment,
      createdAt: r.createdAt,
    })),
  });
});

/**
 * The signed-in student's own reviews for one order. Lets the UI show which
 * items are already rated. Owner only.
 */
router.get("/order/:orderId", authMiddleware, async (req, res) => {
  const orderId = v.objectId(req.params.orderId, "orderId");
  const order = await Order.findById(orderId);
  if (!order) throw ApiError.notFound("Order not found");
  if (order.student.toString() !== req.user._id.toString()) {
    throw ApiError.forbidden("You can only view reviews for your own orders");
  }
  const reviews = await Review.find({ order: orderId, student: req.user._id }).select(
    "food rating comment"
  );
  res.json(
    reviews.map((r) => ({
      foodId: r.food.toString(),
      rating: r.rating,
      comment: r.comment,
    }))
  );
});

module.exports = router;
