const { test } = require("node:test");
const assert = require("node:assert/strict");

/** Pure tests: CSV escaping and formula safety. No database. */

const { csvCell, toCsv } = require("../utils/csv");

test("plain values are written as they are", () => {
  assert.equal(csvCell("Dosa"), "Dosa");
  assert.equal(csvCell(42), "42");
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
});

test("cells with commas, quotes or line breaks are quoted and quotes are doubled", () => {
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("line1\nline2"), '"line1\nline2"');
});

test("text that starts with a formula character is neutralised", () => {
  for (const s of ["=SUM(A1)", "+1", "-2", "@cmd", "\tx", "\rx"]) {
    assert.equal(csvCell(s).replace(/^"/, "").startsWith("'"), true, `expected ${JSON.stringify(s)} to be prefixed`);
  }
});

test("numbers are never prefixed, so negative amounts stay numeric", () => {
  assert.equal(csvCell(-12.5), "-12.5");
  assert.equal(csvCell(0), "0");
});

test("toCsv writes a header, CRLF line endings and a UTF-8 byte order mark", () => {
  const out = toCsv([{ key: "name", label: "Item" }, { key: "amount", label: "Amount (₹)" }], [
    { name: "Dosa, masala", amount: 60 },
  ]);
  assert.equal(out.charCodeAt(0), 0xfeff);
  assert.equal(out.slice(1), 'Item,Amount (₹)\r\n"Dosa, masala",60\r\n');
});

test("toCsv can omit the byte order mark", () => {
  assert.equal(toCsv([{ key: "a", label: "A" }], [{ a: 1 }], { bom: false }), "A\r\n1\r\n");
});
