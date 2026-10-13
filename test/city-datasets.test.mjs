/**
 * Tests for src/city-datasets.ts, the logic behind the get_city_datasets tool.
 *
 * Runs against the BUILT module (dist/city-datasets.js), the same bytes that
 * ship, so build first. Cities come from the installed @urbankitstudio/atlas,
 * so nothing here pins a count: a city added in the next atlas release does not
 * break a test. The one shape the registry cannot supply today, an AMBIGUOUS
 * name, is built from fixtures with the package's own findCityIn.
 *
 * The wire keys asserted here are the hosted tool's (urbankitstudio api/mcp.ts
 * case "get_city_datasets"): snake_case, one level deep.
 *
 * Usage:  node --test test/city-datasets.test.mjs
 * Or via: npm run test:policy
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findCityIn, listCities } from "@urbankitstudio/atlas";
import {
  getCityDatasets,
  SPLIT_ADDRESS_UNMAPPED_NOTE,
  CITY_REF_MAX_LEN,
  CITY_STATE_MAX_LEN,
  CITY_STREET_MAX_LEN,
} from "../dist/city-datasets.js";

/** The answer as an object; asserts it is not an error result first. */
function answer(args, resolve) {
  const r = getCityDatasets(args, resolve);
  assert.equal(r.isError, false, `no error for ${JSON.stringify(args)}: ${r.text}`);
  return JSON.parse(r.text);
}

test("no city lists every covered city, with the hosted wire keys", () => {
  const out = answer({});
  assert.equal(out.total_cities, listCities().length);
  assert.ok(out.total_cities > 0, "the registry carries cities");
  assert.equal(out.cities.length, out.total_cities);
  assert.deepEqual(Object.keys(out).sort(), ["cities", "note", "total_cities"]);
  const dallas = out.cities.find((c) => c.slug === "dallas");
  assert.ok(dallas, "Dallas is listed");
  assert.deepEqual(Object.keys(dallas).sort(), ["city", "county_slug", "kinds", "slug", "state_abbrev"]);
  assert.equal(dallas.state_abbrev, "TX");
});

test("the list narrows by kind and by state", () => {
  const permits = answer({ kind: "permits" });
  assert.ok(permits.cities.length > 0);
  assert.ok(permits.cities.every((c) => c.kinds.includes("permits")));
  assert.ok(permits.total_cities < answer({}).total_cities, "the kind filter removes a city that has no permits");
  const tx = answer({ state: "Texas" });
  assert.ok(tx.cities.length > 0 && tx.cities.every((c) => c.state_abbrev === "TX"));
  assert.deepEqual(answer({ state: "TX" }).cities, tx.cities, "a code and a name select the same cities");
});

test("Dallas permits with a street: found, snake_case keys, a ready query URL, street cut at the comma", () => {
  const out = answer({ city: "Dallas", kind: "permits", street: "600 Commerce St, Dallas, TX" });
  assert.equal(out.found, true);
  assert.deepEqual(
    Object.keys(out).sort(),
    ["city", "datasets", "found", "note", "registry_urls", "scope_note", "source", "street", "urbankit_pages"],
  );
  assert.deepEqual(Object.keys(out.city).sort(), [
    "atlas_county_page", "county_name", "county_slug", "name", "slug", "state", "state_abbrev",
  ]);
  assert.equal(out.city.slug, "dallas");
  assert.equal(out.city.atlas_county_page, "https://urbankitstudio.com/parcel-atlas/texas/dallas-county");
  assert.equal(out.street, "600 Commerce St", "the street is cut at the first comma and trimmed");

  assert.equal(out.datasets.length, 1, "kind=permits returns only permits");
  const [ds] = out.datasets;
  assert.equal(ds.kind, "permits");
  for (const key of [
    "city_slug", "provider", "endpoint", "lookup", "address_field", "date_field", "fields",
    "cors_enabled", "freshness", "query_template", "sample_query", "query_note", "street_used", "query_url",
  ]) {
    assert.ok(key in ds, `dataset carries the snake_case key ${key}`);
  }
  assert.ok(!("cityslug" in ds) && !("addressField" in ds) && !("queryUrl" in ds), "no camelCase wire keys");
  assert.deepEqual(Object.keys(ds.freshness).sort(), ["date_field", "last_verified", "latest_record_date"]);
  assert.equal(ds.cors_enabled, true);
  assert.equal(ds.street_used, "600 Commerce St");
  assert.ok(ds.query_url.startsWith(ds.endpoint), "the query URL runs against the dataset's own endpoint");
  assert.ok(ds.query_url.includes("600%20Commerce%20St"), "the street is in the URL");
  assert.ok(!/Dallas%20|%2C|TX/.test(ds.query_url.slice(ds.endpoint.length)), "nothing past the comma reaches the query");

  assert.equal(out.urbankit_pages.property_report, "https://urbankitstudio.com/tools/property-report/dallas");
  assert.equal(out.urbankit_pages.zoning_cases, null, "kind=permits does not load the zoning record");
  assert.equal(out.registry_urls.property, "https://urbankitstudio.com/data/city-property/dallas.json");
  assert.equal(out.registry_urls.zoning, null);
});

test("Dallas with no kind and no street: every dataset, no query_url, a point template for the zoning map", () => {
  const out = answer({ city: "dallas" });
  assert.equal(out.found, true);
  assert.ok(!("street" in out));
  const kinds = out.datasets.map((d) => d.kind);
  assert.deepEqual(kinds, ["violations", "permits", "zoning"], "violations, then permits, then zoning");
  assert.ok(out.datasets.every((d) => !("query_url" in d) && !("street_used" in d)), "no street, no query_url");
  const zoning = out.datasets.find((d) => d.kind === "zoning");
  assert.equal(zoning.zoning_mode, "current-zoning");
  assert.equal(zoning.lookup, "location");
  assert.equal(zoning.query_template.substitute, "{LON},{LAT}");
  assert.equal(out.urbankit_pages.zoning_cases, "https://urbankitstudio.com/tools/zoning-cases/dallas");
  assert.equal(out.registry_urls.zoning, "https://urbankitstudio.com/data/city-zoning/dallas.json");
});

test("a street on a point-lookup dataset gets a null query_url, never a street pasted into a template", () => {
  const out = answer({ city: "dallas", kind: "zoning", street: "Commerce" });
  const [zoning] = out.datasets;
  assert.equal(zoning.query_url, null);
  assert.ok(zoning.query_template, "the template carries the request instead");
  assert.ok(!JSON.stringify(zoning.query_template).includes("Commerce"), "the street never enters a template");
});

test("a street with an apostrophe is quote-doubled in the URL and cut at the comma (O'Farrell, San Francisco)", () => {
  const out = answer({ city: "san-francisco", kind: "violations", street: "O'Farrell St, San Francisco, CA" });
  assert.equal(out.street, "O'Farrell St", "the comma cut leaves the apostrophe street alone");
  const [ds] = out.datasets;
  assert.equal(ds.street_used, "O'Farrell", "SF splits its address, so the name is matched without the type");
  assert.ok(ds.query_url.includes("O''Farrell"), "the quote is doubled inside the SQL literal");
  assert.ok(!/O'(?!')Farrell/.test(ds.query_url), "no lone quote survives to close the literal early");
  assert.ok(!ds.query_url.includes("Francisco") && !ds.query_url.includes("%2C"), "nothing after the comma is queried");
  assert.ok(ds.query_note.endsWith(SPLIT_ADDRESS_UNMAPPED_NOTE), "the split-address caveat is stated");
});

test("the split-address caveat is absent when the street was not changed", () => {
  const withStreet = answer({ city: "san-francisco", kind: "violations", street: "Market" });
  assert.ok(!withStreet.datasets[0].query_note.includes(SPLIT_ADDRESS_UNMAPPED_NOTE), "a bare name is matched as typed");
  const noStreet = answer({ city: "san-francisco", kind: "violations" });
  assert.ok(!noStreet.datasets[0].query_note.includes(SPLIT_ADDRESS_UNMAPPED_NOTE));
});

test("an ambiguous name returns a list to choose from, not a guess", () => {
  const fixture = [
    { slug: "columbus-oh", city: "Columbus", state: "Ohio", stateAbbrev: "OH", kinds: ["permits"], names: ["Columbus"] },
    { slug: "columbus-ga", city: "Columbus", state: "Georgia", stateAbbrev: "GA", kinds: ["violations"], names: ["Columbus"] },
  ];
  const resolve = (ref, state) => findCityIn(fixture, ref, state);
  const out = answer({ city: "Columbus" }, resolve);
  assert.equal(out.found, false);
  assert.equal(out.ambiguous, true);
  assert.deepEqual(out.matches.map((m) => m.slug), ["columbus-oh", "columbus-ga"]);
  assert.deepEqual(Object.keys(out).sort(), ["ambiguous", "city", "found", "hint", "matches"]);
  assert.ok(!("datasets" in out), "an ambiguous answer carries no datasets");
  // The state narrows it to one: proves the state argument reaches the resolver.
  const narrowed = answer({ city: "Columbus", state: "GA" }, resolve);
  assert.equal(narrowed.found, true);
  assert.ok(!("ambiguous" in narrowed));
  assert.equal(narrowed.city.slug, "columbus-ga");
});

test("an unknown city is found:false with the hosted keys and the cities in its state", () => {
  const out = answer({ city: "Aurora", state: "IL" });
  assert.equal(out.found, false);
  assert.ok(!("ambiguous" in out));
  assert.deepEqual(Object.keys(out).sort(), ["cities_in_state", "city", "found", "hint", "message", "state"]);
  assert.equal(out.state, "IL");
  assert.ok(out.cities_in_state.every((c) => c.state_abbrev === "IL"));
  assert.match(out.message, /No covered city matches 'Aurora' in IL/);
  assert.match(out.message, /\(find_county\)/, "points at this server's tool, not the hosted find_parcel_by_address");
});

test("a county reference returns the covered cities inside it", () => {
  const out = answer({ city: "dallas-county" });
  assert.equal(out.found, false);
  assert.deepEqual(out.cities_in_county.map((c) => c.slug), ["dallas"]);
  const noState = answer({ city: "Nowhere ZZ" });
  assert.equal(noState.found, false);
  assert.ok(!("cities_in_county" in noState));
});

test("a state read off 'City, ST' is used for the not-found hint", () => {
  const out = answer({ city: "Aurora, IL" });
  assert.equal(out.found, false);
  assert.equal(out.state, "IL");
  assert.ok(out.cities_in_state.length > 0);
});

test("a kind the city lacks is found:true with no datasets and says which kinds it has", () => {
  const chicago = listCities().find((c) => c.slug === "chicago");
  assert.ok(chicago && !chicago.kinds.includes("zoning"), "fixture: Chicago has no zoning dataset");
  const out = answer({ city: "Chicago", kind: "zoning" });
  assert.equal(out.found, true);
  assert.deepEqual(out.datasets, []);
  assert.match(out.note, /no zoning dataset/);
  assert.match(out.note, /violations/);
});

test("a path-shaped or prototype-shaped ref is not a city, and nothing is read", () => {
  for (const ref of ["../atlas/index", "..\\atlas\\index", "dallas/../boston", "city-property/dallas", "__proto__", "constructor", "hasOwnProperty", "%2e%2e/x"]) {
    const out = answer({ city: ref });
    assert.equal(out.found, false, `${ref} is not a city`);
    assert.ok(!("datasets" in out) && !("city_slug" in out), `${ref} yields no record`);
  }
});

test("over-long, malformed and out-of-enum arguments are errors, not answers", () => {
  const cases = [
    [{ city: "x".repeat(CITY_REF_MAX_LEN + 1) }, /city must be at most 80/],
    [{ city: "dallas", state: "x".repeat(CITY_STATE_MAX_LEN + 1) }, /state must be at most 40/],
    [{ city: "dallas", street: "x".repeat(CITY_STREET_MAX_LEN + 1) }, /street must be at most 120/],
    [{ city: "dallas", kind: "bogus" }, /kind must be/],
    [{ city: "dallas", street: "Main \ud800" }, /street must be well-formed text/],
    [{ city: "dal\udfffas" }, /city must be well-formed text/],
  ];
  for (const [args, pattern] of cases) {
    const r = getCityDatasets(args);
    assert.equal(r.isError, true, JSON.stringify(args).slice(0, 60));
    assert.match(r.text, pattern);
  }
  assert.equal(getCityDatasets({ city: "dallas", street: "x".repeat(CITY_STREET_MAX_LEN) }).isError, false, "the cap itself is allowed");
  assert.equal(CITY_REF_MAX_LEN, 80);
  assert.equal(CITY_STATE_MAX_LEN, 40);
  assert.equal(CITY_STREET_MAX_LEN, 120);
});

test("the handler lower-cases kind (defence in depth: over stdio the SDK schema refuses 'PERMITS' first)", () => {
  assert.equal(answer({ city: "dallas", kind: "PERMITS" }).datasets[0].kind, "permits");
});

test("nothing in the tool calls fetch: every path answers from the bundled registry", () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    throw new Error("get_city_datasets must not fetch");
  };
  try {
    getCityDatasets({});
    getCityDatasets({ city: "dallas", street: "Commerce" });
    getCityDatasets({ city: "san-francisco", street: "O'Farrell St, SF" });
    getCityDatasets({ city: "nowhere" });
    getCityDatasets({ city: "../atlas/index" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls, 0);
});
