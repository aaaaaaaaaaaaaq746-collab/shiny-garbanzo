/**
 * Generate a strong random secret for JWT_SECRET.
 *
 *   npm run generate:secret
 *
 * The output is a single line you paste into .env. It is intentionally not
 * written to any file, so the value never lands in version control.
 */
const crypto = require("crypto");

const secret = crypto.randomBytes(48).toString("base64url");

console.log("Add this line to your .env file:\n");
console.log(`JWT_SECRET=${secret}\n`);
console.log("Then restart the server. Any tokens signed with the old secret");
console.log("will become invalid, so users will need to log in again.");