/**
 * CSV output for admin exports. Pure.
 *
 * Follows RFC 4180: CRLF line endings, quoting for commas, quotes and line
 * breaks. Text cells that begin with = + - @ or a tab/CR are prefixed with an
 * apostrophe so a spreadsheet cannot run them as a formula. Numbers are never
 * prefixed, so negative amounts stay numeric.
 */

function csvCell(value) {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * `columns` is [{ key, label }]; `rows` are objects keyed by column key.
 * A UTF-8 byte order mark is added so Excel shows ₹ and other non-ASCII text correctly.
 */
function toCsv(columns, rows, { bom = true } = {}) {
  const lines = [columns.map((c) => csvCell(c.label)).join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => csvCell(row[c.key])).join(","));
  }
  return `${bom ? "\uFEFF" : ""}${lines.join("\r\n")}\r\n`;
}

module.exports = { csvCell, toCsv };
