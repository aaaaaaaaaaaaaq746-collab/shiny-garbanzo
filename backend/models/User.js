const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const ROLES = ["student", "staff", "admin"];

const UserSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    maxlength: 254,
  },
  password: { type: String, required: true, select: false },
  // "staff" was added for kitchen/order-desk access. Existing documents
  // ("student"/"admin") remain valid.
  role: { type: String, enum: ROLES, default: "student" },

  // ---- Additive Phase 3/4 fields. Every one has a default so existing
  // ---- documents continue to validate untouched.
  phone: { type: String, default: null, trim: true },
  isActive: { type: Boolean, default: true },
  // Incremented on logout. A token carries the value it was issued with (`tv`);
  // a mismatch means the session was ended. Default 0 keeps existing users valid.
  tokenVersion: { type: Number, default: 0, min: 0 },
  favorites: [{ type: mongoose.Schema.Types.ObjectId, ref: "FoodItem" }],
  notificationPrefs: {
    orderUpdates: { type: Boolean, default: true },
    promotions: { type: Boolean, default: false },
    sound: { type: Boolean, default: true },
  },
}, {
  timestamps: true,
  toJSON: {
    // Never serialize the password hash, even if it was selected.
    transform(doc, ret) {
      delete ret.password;
      delete ret.__v;
      return ret;
    },
  },
});

// Pre-save hook to hash password
UserSchema.pre("save", async function () {
  if (!this.isModified("password")) return;

  this.password = await bcrypt.hash(this.password, 10);
});

// Compare password method
UserSchema.methods.comparePassword = async function (password) {
  if (typeof password !== "string" || !password) return false;
  return bcrypt.compare(password, this.password);
};

/** Safe public projection used by API responses. */
UserSchema.methods.toPublicJSON = function () {
  return {
    id: this._id.toString(),
    name: this.name,
    email: this.email,
    role: this.role,
  };
};

const User = mongoose.model("User", UserSchema);

module.exports = User;
module.exports.ROLES = ROLES;