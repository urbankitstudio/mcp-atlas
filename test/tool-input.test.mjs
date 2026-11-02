/**
 * Tests for src/tool-input.ts, the check every free-text tool argument passes:
 * no ASCII control character (CR, LF, TAB and NUL among them), no C1 control
 * (NEL and CSI among them), no Unicode line or paragraph separator and no bidi
 * control, so an argument echoed into an answer cannot start a line of its own
 * there or read differently from what was sent. test/smoke.mjs checks that
 * every tool's schema is built with it.
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
const ch = (code) => String.fromCharCode(code);

const REJECTED = [
  ["U+0080 (first C1)", `SMITH${ch(0x80)}`],
  ["NEL U+0085", `SMITH${ch(0x85)}Query URL:`],
  ["CSI U+009B", `SMITH${ch(0x9b)}2J`],
  ["U+009F (last C1)", `SMITH${ch(0x9f)}`],
  ["ALM U+061C", `SMITH${ch(0x61c)}`],
  ["LRM U+200E", `SMITH${ch(0x200e)}`],
  ["RLM U+200F", `SMITH${ch(0x200f)}`],
  ["LRE U+202A", `SMITH${ch(0x202a)}`],
  ["RLO U+202E", `SMITH${ch(0x202e)}HTIMS`],
  ["LRI U+2066", `SMITH${ch(0x2066)}`],
  ["PDI U+2069", `SMITH${ch(0x2069)}`],
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

test("every Bidi_Control code point in this engine's Unicode data is rejected, not only the listed ones", () => {
  let seen = 0;
  for (let c = 0; c <= 0xffff; c++) {
    if (c >= 0xd800 && c <= 0xdfff) continue;
    if (!/\p{Bidi_C}/u.test(ch(c))) continue;
    seen++;
    assert.equal(freeText().safeParse(`A${ch(c)}B`).success, false, `U+${c.toString(16).toUpperCase()}`);
  }
  assert.ok(seen >= 12, `the Bidi_Control set was found (saw ${seen})`);
});

test("ordinary names pass: an apostrophe, a curly apostrophe, a comma, an ampersand, accents", () => {
  // U+00A0 (just past C1), U+200D (just before LRM), U+2070 (just past PDI)
  // and U+061B/U+061D (beside ALM) are the edges the ranges must not swallow.
  // U+200B, U+FEFF and the soft hyphen U+00AD pass on purpose: they break no
  // line and reorder nothing (README says so).
  for (const value of [
    "O'NEIL",
    "Prince George’s",
    "SMITH, JOHN",
    "A & B LLC",
    "Peña",
    "  Kane  ",
    `A${ch(0xa0)}B`,
    `A${ch(0x200d)}B`,
    `A${ch(0x2070)}`,
    `A${ch(0x61b)}B`,
    `A${ch(0x61d)}B`,
    `A${ch(0x200b)}B`,
    `A${ch(0xfeff)}B`,
    `A${ch(0xad)}B`,
  ]) {
    assert.equal(freeText().safeParse(value).success, true, `U+ codes ${[...value].map((x) => x.codePointAt(0).toString(16)).join(" ")}`);
  }
});

test("the check survives the chained constraints the tools add", () => {
  assert.equal(freeText().min(2).safeParse("a\nb").success, false);
  assert.equal(freeText().max(80).optional().safeParse("a\nb").success, false);
  assert.equal(freeText().max(80).optional().safeParse(undefined).success, true);
});
