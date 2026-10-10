const mongoose = require("mongoose");

/**
 * Orders booked into one pickup slot.
 *
 * `_id` is the slot start as an ISO string. The count is changed only with
 * conditional updates (see services/pickupCapacity.js), so two students
 * cannot both take the last seat in a slot.
 */
const PickupSlotCountSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    count: { type: Number, default: 0, min: 0 },
  },
  { versionKey: false }
);

module.exports = mongoose.model("PickupSlotCount", PickupSlotCountSchema);
