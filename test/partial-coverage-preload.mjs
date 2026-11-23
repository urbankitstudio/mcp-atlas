/**
 * Preload for the partial-coverage tests in test/owner-join.test.mjs:
 * `node --import <this file> dist/server.js`.
 *
 * The installed atlas gives partialCoverage only to records that carry an endpoint
 * (Providence RI, Cumberland, York and Kennebec ME), so the summary branch for a
 * record with no endpoint is never reached by real data. This adds one such record
 * to the package's in-memory Delaware file, so the built server's own handlers can
 * be driven over stdio against it. Nothing is written to disk and nothing is fetched.
 */
import { atlas, countySlugFromName } from "@urbankitstudio/atlas";

export const NO_ENDPOINT_PARTIAL_NAME = "Partial Fixture";
export const NO_ENDPOINT_PARTIAL = {
  covers: ["Fixtureville"],
  notCovered: ["Alpha Township", "Beta Borough"],
  checked: "2026-11-23",
};

const delaware = atlas.byStateSlug.get("delaware");
if (!delaware) throw new Error("partial-coverage-preload: the installed atlas has no Delaware file to add the fixture to");
delaware.counties.push({
  id: "de-partial-fixture",
  state: "DE",
  stateName: "Delaware",
  stateSlug: "delaware",
  county: NO_ENDPOINT_PARTIAL_NAME,
  countySlug: countySlugFromName(NO_ENDPOINT_PARTIAL_NAME),
  countyFips: "10994",
  hasPublicRest: false,
  endpoints: [],
  contact: { department: "Fixture", url: null, email: null },
  notes: "",
  partialCoverage: NO_ENDPOINT_PARTIAL,
  coverage: {
    reason: "attributes-missing",
    summary: "Fixture record with no endpoint.",
    checked: "2026-11-23",
  },
});
