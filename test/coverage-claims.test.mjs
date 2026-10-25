/**
 * Tests for scripts/sync-coverage.mjs: the coverage numbers in README.md, the
 * package.json description and the server.json description are the installed
 * atlas's, never hand-typed ones.
 *
 * Usage:  node --test test/coverage-claims.test.mjs
 * Or via: npm run test:policy
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { atlasIndex } from "@urbankitstudio/atlas";
import { coverageEdits, coverageFacts, rewriteSite, SITES } from "../scripts/sync-coverage.mjs";

test("every coverage claim on disk equals what the installed atlas derives", () => {
  for (const { file, before, after } of coverageEdits()) {
    assert.equal(before, after, `${file} carries a stale coverage claim: run node scripts/sync-coverage.mjs`);
  }
});

test("the facts come from the atlas's own totals", () => {
  const f = coverageFacts();
  const t = atlasIndex.totals;
  assert.equal(f.counties, t.counties);
  assert.equal(f.endpoints, t.endpoints);
  assert.equal(f.states, t.states);
  assert.equal(f.withEndpoint, t.countiesWithEndpoint);
  assert.equal(f.without, t.counties - t.countiesWithEndpoint);
  assert.ok(f.live > 0 && f.live <= f.endpoints, `live ${f.live} of ${f.endpoints}`);
});

test("a stale number is rewritten, and a claim the pattern cannot find is an error", () => {
  const f = { states: 51, counties: 501, endpoints: 496, live: 496, withEndpoint: 469, without: 32, floor: "0.6.43" };
  const site = SITES.find((s) => s.file === "server.json");
  assert.equal(
    rewriteSite('"Owner and APN lookup across 499 US counties (497 ArcGIS endpoints)."', site, f),
    '"Owner and APN lookup across 501 US counties (496 ArcGIS endpoints)."',
  );
  assert.throws(() => rewriteSite("Owner and APN lookup in many counties.", site, f), /expected exactly 1 coverage claim/);
});
