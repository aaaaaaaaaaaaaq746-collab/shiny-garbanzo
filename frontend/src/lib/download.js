/**
 * Save text (for example a receipt) as a file in the browser.
 * Uses a short-lived object URL so no data is left in the page.
 */
export function saveTextFile(filename, text, mime = "text/plain;charset=utf-8") {
  saveBlob(filename, new Blob([text], { type: mime }));
}

/** Save a Blob (for example a CSV download) as a file. */
export function saveBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
