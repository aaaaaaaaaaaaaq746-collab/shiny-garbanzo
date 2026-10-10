import api from "../api";

/** Accepted menu photo types and size, mirrored from the server (utils/images.js). */
export const IMAGE_TYPES = Object.freeze(["image/jpeg", "image/png", "image/webp"]);
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** A message when the file cannot be uploaded, or null when it looks acceptable. */
export function imageProblem(file) {
  if (!file) return "Choose an image";
  if (!IMAGE_TYPES.includes(file.type)) return "Choose a JPEG, PNG or WebP image";
  if (file.size > MAX_IMAGE_BYTES) return "The image must be 2 MB or smaller";
  return null;
}

/**
 * Upload a menu photo. The server checks the file's contents, not just its
 * name. Resolves to the updated menu item.
 */
export async function uploadMenuImage(foodId, file) {
  const problem = imageProblem(file);
  if (problem) throw new Error(problem);
  const res = await api.post(`/food/${foodId}/image`, file, {
    headers: { "Content-Type": file.type },
  });
  return res.data;
}
