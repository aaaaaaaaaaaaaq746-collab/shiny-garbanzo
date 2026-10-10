const { test } = require("node:test");
const assert = require("node:assert/strict");

/** Pure tests: image type detection and stored path checks. No filesystem. */

const { sniffImageType, isLocalImagePath, ALLOWED_IMAGE_TYPES } = require("../utils/images");

const pad = (head) => Buffer.concat([Buffer.from(head), Buffer.alloc(16)]);

test("a PNG signature is detected", () => {
  assert.equal(sniffImageType(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "png");
});

test("a JPEG signature is detected", () => {
  assert.equal(sniffImageType(pad([0xff, 0xd8, 0xff, 0xe0])), "jpg");
});

test("a WebP container is detected", () => {
  const b = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP"), Buffer.alloc(8)]);
  assert.equal(sniffImageType(b), "webp");
});

test("a file renamed to .png but not actually an image is refused", () => {
  assert.equal(sniffImageType(Buffer.from("<script>alert(1)</script>........")), null);
});

test("SVG is refused, since it can carry script", () => {
  assert.equal(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.equal(ALLOWED_IMAGE_TYPES["image/svg+xml"], undefined);
});

test("GIF is not on the allowed list", () => {
  assert.equal(sniffImageType(Buffer.from("GIF89a" + "\0".repeat(10))), null);
});

test("too-short input is refused", () => {
  assert.equal(sniffImageType(Buffer.from([0xff, 0xd8])), null);
  assert.equal(sniffImageType(null), null);
});

test("only generated upload paths are accepted as stored image references", () => {
  assert.equal(isLocalImagePath("/uploads/food/0123456789abcdef0123456789abcdef.jpg"), true);
  assert.equal(isLocalImagePath("/uploads/food/../../config.js"), false);
  assert.equal(isLocalImagePath("https://example.com/a.jpg"), false);
  assert.equal(isLocalImagePath("/uploads/food/0123456789abcdef0123456789abcdef.gif"), false);
});
