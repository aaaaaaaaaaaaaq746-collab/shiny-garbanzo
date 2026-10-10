/**
 * Provision an administrator account.
 *
 * Public signup can no longer create admins (it always forces the "student"
 * role), so this script is the supported way to bootstrap and to add staff.
 *
 *   npm run seed:admin
 *   ADMIN_EMAIL=head@college.edu ADMIN_PASSWORD="s3cret-pass" npm run seed:admin
 *   npm run seed:admin -- --role staff
 *
 * The password is read from the environment and is never prompted for or
 * echoed, so it does not end up in shell history or CI logs.
 */
require("dotenv").config();

const mongoose = require("mongoose");
const User = require("../models/User");
const config = require("../config");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

async function seedAdmin() {
  const args = parseArgs(process.argv.slice(2));

  const email = (args.email || process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const name = (args.name || process.env.ADMIN_NAME || "").trim() || "Canteen Admin";
  const password = args.password || process.env.ADMIN_PASSWORD;
  const role = args.role || process.env.ADMIN_ROLE || "admin";

  const missing = [];
  if (!email) missing.push("email (ADMIN_EMAIL or --email)");
  if (!password) missing.push("password (ADMIN_PASSWORD or --password)");
  if (missing.length) {
    console.error(`Missing required value(s): ${missing.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  if (!User.ROLES.includes(role)) {
    console.error(`Invalid role "${role}". Valid roles: ${User.ROLES.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  if (password.length < 8) {
    console.error("ADMIN_PASSWORD must be at least 8 characters.");
    process.exitCode = 1;
    return;
  }

  await mongoose.connect(config.mongoUri);

  const existing = await User.findOne({ email });
  if (existing) {
    // Idempotent: re-running promotes/updates rather than crashing.
    existing.role = role;
    if (name) existing.name = name;
    await existing.save();
    console.log(`Updated existing account ${email} -> role "${role}"`);
  } else {
    await User.create({ name, email, password, role });
    console.log(`Created ${role} account: ${email}`);
  }

  await mongoose.disconnect();
}

seedAdmin().catch(async (err) => {
  console.error("Seed failed:", err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});