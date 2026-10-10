import React, { useState } from "react";
import { IMAGE_TYPES, uploadMenuImage } from "../lib/menuImage";

/**
 * Pick a menu photo and upload it to an existing item.
 * Calls onUploaded(updatedFood) after a successful upload.
 */
export default function MenuImageInput({ foodId, disabled = false, onUploaded }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const handleFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // allow picking the same file again
    if (!file) return;
    setError("");
    setBusy(true);
    try {
      const updated = await uploadMenuImage(foodId, file);
      onUploaded?.(updated);
    } catch (err) {
      setError(err.message || "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="text-sm">
      <label className="inline-flex items-center gap-2">
        <span className="font-semibold text-purple-700">Photo</span>
        <input
          type="file"
          accept={IMAGE_TYPES.join(",")}
          aria-label="Upload menu photo"
          disabled={disabled || busy}
          onChange={handleFile}
          className="text-xs"
        />
      </label>
      {busy && <span className="ml-2 text-gray-500">Uploading...</span>}
      {error && (
        <p role="alert" className="text-red-600 text-xs mt-1">
          {error}
        </p>
      )}
    </div>
  );
}
