/**
 * Menu image checks. Pure: no filesystem, no network.
 *
 * An upload is accepted only when its first bytes match a JPEG, PNG or WebP
 * signature. The client's Content-Type and file name are not trusted. SVG is
 * refused on purpose: it can carry script.
 */

const ALLOWED_IMAGE_TYPES = Object.freeze({
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
});

/** "jpg" | "png" | "webp" from the bytes, or null when they match no allowed signature. */
function sniffImageType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (pngSignature.every((byte, i) => buffer[i] === byte)) return "png";
  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

/** Path form a locally stored menu image is saved and referenced by. */
const LOCAL_IMAGE_PATH = /^\/uploads\/food\/[a-f0-9]{32}\.(jpg|png|webp)$/;

function isLocalImagePath(value) {
  return typeof value === "string" && LOCAL_IMAGE_PATH.test(value);
}

module.exports = { ALLOWED_IMAGE_TYPES, sniffImageType, LOCAL_IMAGE_PATH, isLocalImagePath };
