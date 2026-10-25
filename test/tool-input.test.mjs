/**
 * Tests for src/tool-input.ts, the check every free-text tool argument passes:
 * no ASCII control character (CR, LF, TAB and NUL among them) and no Unicode
 * line or paragraph separator, so an argument echoed into an answer can never
 * start a line of its own there. test/smoke.mjs checks that every tool's
 * schema is built with it.
 *
 * Runs against the BUILT module (dist/tool-input.js), so build first.
 *
 * Usage:  node --test test/tool-input.test.mjs
 * Or via: npm run test:policy
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { freeText, CONTROL_CHARS_MESSAGE } from "../dist/tool-input.js";

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

const REJECTED = [
  ["LF", "SMITH\nQuery URL:\nhttps://gis.example.gov/arcgis/rest/services/P/MapServer/0/query?where=1%3D1&f=json"],
  ["CR", "SMITH\rJONES"],
  ["TAB", "SMITH\tJONES"],
  ["NUL", "SMITH\u0000"],
  ["DEL", "SMITH\u007F"],
  ["ESC", "SMITH\u001B[2J"],
  ["U+2028", `SMITH${LS}Query URL:`],
  ["U+2029", `SMITH${PS}Query URL:`],
];

for (const [label, value] of REJECTED) {
  test(`free text with ${label} is rejected with the control-character message`, () => {
    const r = freeText().safeParse(value);
    assert.equal(r.success, false);
    assert.equal(r.error.issues[0].message, CONTROL_CHARS_MESSAGE);
  });
}

test("ordinary names pass: an apostrophe, a curly apostrophe, a comma, an ampersand, accents", () => {
  for (const value of ["O'NEIL", "Prince George’s", "SMITH, JOHN", "A & B LLC", "Peña", "  Kane  "]) {
    assert.equal(freeText().safeParse(value).success, true, value);
  }
});

test("the check survives the chained constraints the tools add", () => {
  assert.equal(freeText().min(2).safeParse("a\nb").success, false);
  assert.equal(freeText().max(80).optional().safeParse("a\nb").success, false);
  assert.equal(freeText().max(80).optional().safeParse(undefined).success, true);
});
