/**
 * Tests for src/search-policy.ts, the one rule deciding whether an owner query
 * is offered on an endpoint and how a shared layer is scoped to one county.
 *
 * Runs against the BUILT module (dist/search-policy.js), the same bytes that
 * ship, so build first. Real counties come from the installed
 * @urbankitstudio/atlas; the searchable:false and scope-plus-owner shapes are
 * synthetic so they hold whatever the registry carries next release.
 *
 * Usage:  node --test test/search-policy.test.mjs
 * Or via: npm run test:policy
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { atlas, findState, reviewedCapability } from "@urbankitstudio/atlas";
import {
  ownerSearchPolicy,
  ownerWhereClause,
  ownerCoverageLabel,
  buildArcgisOwnerQuery,
  ownerQueryRowsNote,
  confidentialExclusion,
  confidentialLine,
  parcelEndpointSamples,
  ownerRefusal,
  ownerLine,
  ATTRIBUTE_SEARCH_UNSUPPORTED_REASON,
  OWNER_UNSEARCHABLE_REASON,
} from "../dist/search-policy.js";

function county(stateSlug, id) {
  const c = findState(stateSlug)?.counties.find((x) => x.id === id);
  assert.ok(c, `registry fixture ${id} exists in the installed atlas`);
  return c;
}

test("Miami-Dade on the FDOR statewide layer: scoped, attribute search refused", () => {
  const md = county("florida", "fl-miami-dade");
  const fdor = md.endpoints.find((ep) => ep.scopeWhere);
  assert.ok(fdor, "Miami-Dade carries a scoped (FDOR) endpoint");
  const p = ownerSearchPolicy(md, fdor);
  assert.equal(p.kind, "attribute_search_unsupported");
  assert.equal(p.field, null, "no owner column is offered on a layer that serves no attribute search");
  assert.equal(p.reason, ATTRIBUTE_SEARCH_UNSUPPORTED_REASON);
  assert.equal(p.scopeWhere, "CO_NO=23", "the county scope is reported even when the query is refused");
});

test("Miami-Dade's own county layer still offers an owner query, so the county reads owner+APN", () => {
  const md = county("florida", "fl-miami-dade");
  const own = md.endpoints.find((ep) => !ep.scopeWhere);
  const p = ownerSearchPolicy(md, own);
  assert.equal(p.kind, "offered");
  assert.equal(p.field, "TRUE_OWNER1");
  assert.equal(ownerCoverageLabel(md), "owner+APN");
});

test("a county served only by the FDOR layer is labelled location queries only", () => {
  assert.equal(ownerCoverageLabel(county("florida", "fl-baker")), "location queries only");
});

test("a reviewed not_published owner keeps its reviewed wording and outranks searchable:false", () => {
  // Bergen's OWNER_NAME is also marked searchable:false; the reviewed record must win.
  const bergen = county("new-jersey", "nj-bergen");
  const p = ownerSearchPolicy(bergen, bergen.endpoints[0]);
  assert.equal(p.kind, "reviewed_unservable");
  assert.equal(p.field, null);
  assert.equal(p.reason, reviewedCapability(bergen, "owner_name").basis.note);
  assert.equal(ownerCoverageLabel(bergen), "APN only (county publishes no owner name)");
});

test("a plain county (Kane IL) gets an unscoped owner query", () => {
  const kane = county("illinois", "il-kane");
  const p = ownerSearchPolicy(kane, kane.endpoints[0]);
  assert.equal(p.kind, "offered");
  assert.equal(p.field, "TaxName");
  assert.equal(p.scopeWhere, null);
  assert.equal(ownerWhereClause(p.field, p.scopeWhere, "SMITH"), "UPPER(TaxName) LIKE UPPER('%SMITH%')");
  assert.equal(ownerCoverageLabel(kane), "owner+APN");
});

test("a plain county matched by LABEL (Mahoning OH, OWNNAME1 'Owner Name 1') gets an unscoped owner query", () => {
  // The name alone fails the owner test; the label is what the UKS classifier reads.
  const mahoning = county("ohio", "oh-mahoning");
  const p = ownerSearchPolicy(mahoning, mahoning.endpoints[0]);
  assert.equal(p.kind, "offered");
  assert.equal(p.field, "OWNNAME1");
  assert.equal(p.scopeWhere, null);
  assert.equal(ownerWhereClause(p.field, p.scopeWhere, "SMITH"), "UPPER(OWNNAME1) LIKE UPPER('%SMITH%')");
  assert.equal(ownerCoverageLabel(mahoning), "owner+APN");
});

test("synthetic: an owner ADDRESS column is never offered as the owner name", () => {
  const p = ownerSearchPolicy({}, {
    searchFields: [
      { name: "OWNER_ADDR", label: "Owner Address", searchable: true },
      { name: "OWNERCITY", label: "Owner City", searchable: true },
    ],
  });
  assert.equal(p.kind, "no_owner_column");
  assert.equal(p.field, null);
});

test("Orleans Parish: attributeSearch unsupported (atlas 0.6.13) refuses owner search, location queries only", () => {
  const orleans = county("louisiana", "la-orleans-parish");
  assert.equal(ownerSearchPolicy(orleans, orleans.endpoints[0]).kind, "attribute_search_unsupported");
  assert.equal(ownerCoverageLabel(orleans), "location queries only");
});

test("synthetic: owner column marked searchable:false is refused with the unsearchable reason", () => {
  const p = ownerSearchPolicy({}, {
    searchFields: [
      { name: "PARCEL_ID", label: "Parcel", searchable: true },
      { name: "OWNER_NAME", label: "Owner", searchable: false },
    ],
  });
  assert.equal(p.kind, "owner_unsearchable");
  assert.equal(p.field, null);
  assert.equal(p.reason, OWNER_UNSEARCHABLE_REASON);
});

test("synthetic: attributeSearch unsupported refuses even a searchable owner column", () => {
  const p = ownerSearchPolicy({}, {
    attributeSearch: "unsupported",
    searchFields: [{ name: "OWNER_NAME", label: "Owner", searchable: true }],
  });
  assert.equal(p.kind, "attribute_search_unsupported");
  assert.equal(p.field, null);
});

test("synthetic: a reviewed not_published owner outranks attributeSearch unsupported (branch order)", () => {
  // An FDOR-style endpoint on a county whose owner name a reviewed record withholds.
  // The reviewed fact is about the COUNTY's data, so it must be what the caller hears.
  const note = "Reviewed: this county withholds owner names on every public layer.";
  const reviewedCounty = {
    capabilityOverrides: {
      owner_name: { status: "not_published", basis: { type: "county_policy", note } },
    },
    endpoints: [{
      scopeWhere: "CO_NO=99",
      attributeSearch: "unsupported",
      searchFields: [{ name: "OWN_NAME", label: "Owner Name", searchable: true }],
    }],
  };
  const p = ownerSearchPolicy(reviewedCounty, reviewedCounty.endpoints[0]);
  assert.equal(p.kind, "reviewed_unservable");
  assert.equal(p.reason, note);
  assert.equal(p.scopeWhere, "CO_NO=99");
  assert.equal(ownerCoverageLabel(reviewedCounty), "APN only (county publishes no owner name)");
});

test("synthetic: a scoped layer's WHERE begins with the scope in parentheses", () => {
  const p = ownerSearchPolicy({}, {
    scopeWhere: "COUNTY='ESSEX'",
    searchFields: [{ name: "OWNER_NAME", label: "Owner", searchable: true }],
  });
  assert.equal(p.kind, "offered");
  assert.equal(p.scopeWhere, "COUNTY='ESSEX'");
  const where = ownerWhereClause(p.field, p.scopeWhere, "O'NEIL");
  assert.equal(where, "(COUNTY='ESSEX') AND UPPER(OWNER_NAME) LIKE UPPER('%O''NEIL%')");
});

// atlas 0.6.30: a layer flagged `supportsPagination: false` answers
// resultRecordCount with HTTP 200 and a 400 error body, so the owner query must
// not carry it. Both records are synthetic so they hold whatever the registry carries.
const OWNER_FIELDS = [{ name: "OWNER_NAME", label: "Owner", searchable: true }];
const pagingEndpoint = { url: "https://gis.example.gov/arcgis/rest/services/P/MapServer/0", searchFields: OWNER_FIELDS };
const flaggedEndpoint = { ...pagingEndpoint, supportsPagination: false, maxRecordCount: 1000 };

test("synthetic: a paginating layer's owner query carries resultRecordCount=25", () => {
  const p = ownerSearchPolicy({}, pagingEndpoint);
  const url = buildArcgisOwnerQuery(pagingEndpoint, p, "SMITH");
  assert.ok(url.endsWith("&f=json&resultRecordCount=25"), url);
  assert.equal(ownerQueryRowsNote(pagingEndpoint), "Returns up to 25 records");
});

test("synthetic: a layer that refuses pagination gets a query without resultRecordCount and a note naming its cap", () => {
  const p = ownerSearchPolicy({}, flaggedEndpoint);
  const url = buildArcgisOwnerQuery(flaggedEndpoint, p, "SMITH");
  assert.ok(url.endsWith("&returnGeometry=false&f=json"), url);
  assert.ok(!/resultRecordCount|resultOffset/i.test(url), url);
  const note = ownerQueryRowsNote(flaggedEndpoint);
  assert.match(note, /does not paginate/);
  assert.match(note, /at most 1000 records/);
  assert.match(note, /exceededTransferLimit/);
  assert.ok(!note.includes("up to 25"), note);
});

test("synthetic: a flagged layer with no declared cap still says it does not paginate", () => {
  const bare = { ...flaggedEndpoint, maxRecordCount: undefined };
  assert.match(ownerQueryRowsNote(bare), /does not paginate.*at most the layer's own record cap/);
});

// atlas 0.6.43: `confidentialFlag` names the county's own column marking an
// owner whose record must not be shown (Texas Tax Code §25.025). Harris packs
// one Y/N per ownership slot, Collin writes T/F, Ector's small-integer conf_flg
// is a forward guess. A NULL cell counts as flagged.

test("Harris TX: the owner query excludes a flag cell that CONTAINS Y, and requests the column", () => {
  const harris = county("texas", "tx-harris");
  const ep = harris.endpoints[0];
  assert.deepEqual(ep.confidentialFlag, { field: "confidential_flag", values: ["Y"] }, "fixture: the installed atlas's marker");
  const p = ownerSearchPolicy(harris, ep);
  assert.equal(p.kind, "offered");
  assert.deepEqual(p.confidential, {
    kind: "exclude",
    field: "confidential_flag",
    where: "UPPER(CAST(confidential_flag AS VARCHAR(255))) NOT LIKE '%Y%'",
    values: ["Y"],
  });
  assert.equal(
    ownerWhereClause(p.field, p.scopeWhere, "SMITH", p.confidential),
    "(UPPER(owner_name_1) LIKE UPPER('%SMITH%')) AND UPPER(CAST(confidential_flag AS VARCHAR(255))) NOT LIKE '%Y%'",
  );
  const url = new URL(buildArcgisOwnerQuery(ep, p, "SMITH"));
  assert.equal(
    url.searchParams.get("where"),
    "(UPPER(owner_name_1) LIKE UPPER('%SMITH%')) AND UPPER(CAST(confidential_flag AS VARCHAR(255))) NOT LIKE '%Y%'",
  );
  assert.ok(url.searchParams.get("outFields").split(",").includes("confidential_flag"), "the flag column is requested");
});

test("Collin TX: a one-character 'T' is a contains test too", () => {
  const collin = county("texas", "tx-collin");
  const p = ownerSearchPolicy(collin, collin.endpoints[0]);
  assert.equal(
    ownerWhereClause(p.field, p.scopeWhere, "SMITH", p.confidential),
    "(UPPER(GIS_DBO_AD_Entity_file_as_name) LIKE UPPER('%SMITH%')) AND UPPER(CAST(GIS_DBO_AD_Entity_confidential_ AS VARCHAR(255))) NOT LIKE '%T%'",
  );
  const url = new URL(buildArcgisOwnerQuery(collin.endpoints[0], p, "SMITH"));
  assert.ok(url.searchParams.get("outFields").split(",").includes("GIS_DBO_AD_Entity_confidential_"));
});

test("Ector TX: the small-integer conf_flg is cast to text, which its server accepts", () => {
  const ector = county("texas", "tx-ector");
  assert.deepEqual(ector.endpoints[0].confidentialFlag, { field: "conf_flg", values: ["1"] }, "fixture: the installed atlas's marker");
  const p = ownerSearchPolicy(ector, ector.endpoints[0]);
  assert.equal(p.confidential.where, "UPPER(CAST(conf_flg AS VARCHAR(255))) NOT LIKE '%1%'");
  assert.equal(
    ownerWhereClause(p.field, p.scopeWhere, "SMITH", p.confidential),
    "(UPPER(owner_name) LIKE UPPER('%SMITH%')) AND UPPER(CAST(conf_flg AS VARCHAR(255))) NOT LIKE '%1%'",
  );
});

// The URL-encoded where, pinned as the bytes the URL carries, so a change in
// the encoding (not only in the clause) fails too.
test("the three flagged owner query URLs carry these exact encoded where clauses and flag columns", () => {
  const expected = {
    "tx-harris": [
      "(UPPER(owner_name_1)%20LIKE%20UPPER('%25SMITH%25'))%20AND%20UPPER(CAST(confidential_flag%20AS%20VARCHAR(255)))%20NOT%20LIKE%20'%25Y%25'",
      "HCAD_NUM,acct_num,owner_name_1,owner_name_2,site_str_num,site_str_name,site_city,site_zip,mail_addr_1,confidential_flag",
    ],
    "tx-collin": [
      "(UPPER(GIS_DBO_AD_Entity_file_as_name)%20LIKE%20UPPER('%25SMITH%25'))%20AND%20UPPER(CAST(GIS_DBO_AD_Entity_confidential_%20AS%20VARCHAR(255)))%20NOT%20LIKE%20'%25T%25'",
      "GIS_DBO_AD_Entity_file_as_name,GIS_DBO_AD_Entity_situs_display,GIS_DBO_Parcel_PROP_ID,GIS_DBO_Parcel_GEO_ID,GIS_DBO_AD_Entity_confidential_",
    ],
    "tx-ector": [
      "(UPPER(owner_name)%20LIKE%20UPPER('%25SMITH%25'))%20AND%20UPPER(CAST(conf_flg%20AS%20VARCHAR(255)))%20NOT%20LIKE%20'%251%25'",
      "PIN,strap,owner_name,owner_addr,conf_flg",
    ],
  };
  for (const [id, [where, outFields]] of Object.entries(expected)) {
    const c = county("texas", id);
    const raw = buildArcgisOwnerQuery(c.endpoints[0], ownerSearchPolicy(c, c.endpoints[0]), "SMITH");
    assert.equal(raw.match(/[?&]where=([^&]*)/)?.[1], where, `${id} encoded where`);
    assert.equal(raw.match(/[?&]outFields=([^&]*)/)?.[1], outFields, `${id} outFields`);
  }
});

test("CONTROL Kane IL carries no flag, and its owner query is byte-identical to 0.3.10's", () => {
  const kane = county("illinois", "il-kane");
  const ep = kane.endpoints[0];
  assert.equal(ep.confidentialFlag, undefined);
  const p = ownerSearchPolicy(kane, ep);
  assert.equal(p.confidential, null);
  assert.equal(ownerWhereClause(p.field, p.scopeWhere, "SMITH", p.confidential), "UPPER(TaxName) LIKE UPPER('%SMITH%')");
  assert.equal(
    buildArcgisOwnerQuery(ep, p, "SMITH"),
    "https://gistech.countyofkane.org/arcgis/rest/services/KanePINList/MapServer/0/query?where=UPPER(TaxName)%20LIKE%20UPPER('%25SMITH%25')&outFields=PIN,TaxName,SiteAddress,SiteCity,MailingAddress&returnGeometry=false&f=json&resultRecordCount=25",
  );
});

test("every flagged endpoint in the installed atlas gets the exclusion in its owner query", () => {
  // Spelled out per county, never derived from p.confidential.where, so a
  // weakened exclusion fails here. A county the atlas newly flags fails too,
  // until its full clause is written into this table.
  const expected = {
    "tx-harris":
      "(UPPER(owner_name_1) LIKE UPPER('%SMITH%')) AND UPPER(CAST(confidential_flag AS VARCHAR(255))) NOT LIKE '%Y%'",
    "tx-collin":
      "(UPPER(GIS_DBO_AD_Entity_file_as_name) LIKE UPPER('%SMITH%')) AND UPPER(CAST(GIS_DBO_AD_Entity_confidential_ AS VARCHAR(255))) NOT LIKE '%T%'",
    "tx-ector":
      "(UPPER(owner_name) LIKE UPPER('%SMITH%')) AND UPPER(CAST(conf_flg AS VARCHAR(255))) NOT LIKE '%1%'",
  };
  const seen = [];
  for (const stateFile of atlas.byStateSlug.values()) {
    for (const c of stateFile.counties) {
      for (const ep of c.endpoints) {
        if (ep.confidentialFlag === undefined) continue;
        seen.push(c.id);
        const p = ownerSearchPolicy(c, ep);
        assert.equal(p.confidential?.kind, "exclude", `${c.id} reports a well-formed flag`);
        const where = new URL(buildArcgisOwnerQuery(ep, p, "SMITH")).searchParams.get("where");
        assert.equal(where, expected[c.id], `${c.id}: the full sample where`);
      }
    }
  }
  assert.deepEqual(seen.sort(), Object.keys(expected).sort(), "every flagged county in the installed atlas has a pinned clause");
});

test("synthetic: a longer value is a contains test too, several values AND together, the scope stays first", () => {
  const p = ownerSearchPolicy({}, {
    scopeWhere: "CNTY=7",
    confidentialFlag: { field: "CONF", values: ["Y", "SEALED"] },
    searchFields: OWNER_FIELDS,
  });
  assert.equal(
    ownerWhereClause(p.field, p.scopeWhere, "SMITH", p.confidential),
    "((CNTY=7) AND UPPER(OWNER_NAME) LIKE UPPER('%SMITH%')) AND UPPER(CAST(CONF AS VARCHAR(255))) NOT LIKE '%Y%' AND UPPER(CAST(CONF AS VARCHAR(255))) NOT LIKE '%SEALED%'",
  );
});

test("synthetic: a refused endpoint still reports its flag, like its scope", () => {
  const p = ownerSearchPolicy({}, {
    attributeSearch: "unsupported",
    confidentialFlag: { field: "CONF", values: ["Y"] },
    searchFields: OWNER_FIELDS,
  });
  assert.equal(p.kind, "attribute_search_unsupported");
  assert.equal(p.confidential.field, "CONF");
});

test("synthetic: a flag column already among the searchable fields is not requested twice, and the exclusion stays", () => {
  const ep = { ...pagingEndpoint, confidentialFlag: { field: "OWNER_NAME", values: ["Y"] } };
  const url = new URL(buildArcgisOwnerQuery(ep, ownerSearchPolicy({}, ep), "SMITH"));
  assert.equal(url.searchParams.get("outFields"), "OWNER_NAME");
  assert.equal(
    url.searchParams.get("where"),
    "(UPPER(OWNER_NAME) LIKE UPPER('%SMITH%')) AND UPPER(CAST(OWNER_NAME AS VARCHAR(255))) NOT LIKE '%Y%'",
  );
});

test("synthetic: a lowercase flag value becomes uppercase in the clause, against an UPPERed cell", () => {
  const c = confidentialExclusion({ field: "CONF", values: ["y", "sealed"] });
  assert.deepEqual(c, {
    kind: "exclude",
    field: "CONF",
    where: "UPPER(CAST(CONF AS VARCHAR(255))) NOT LIKE '%Y%' AND UPPER(CAST(CONF AS VARCHAR(255))) NOT LIKE '%SEALED%'",
    values: ["Y", "SEALED"],
  });
});

// A flag that is PRESENT but malformed must never read as "no flag": that
// would drop the exclusion and hand out the owners it exists to keep out.
const BAD_VALUE = "a flag value is not ASCII letters and digits only";
const MALFORMED_FLAGS = [
  ["empty values", { field: "CONF", values: [] }, "the flag lists no values"],
  ["missing values", { field: "CONF" }, "the flag lists no values"],
  ["missing field", { values: ["Y"] }, "the flag names no usable column"],
  ["empty field", { field: "", values: ["Y"] }, "the flag names no usable column"],
  ["field that is not an identifier", { field: "CONF) OR (1=1", values: ["Y"] }, "the flag names no usable column"],
  ["non-string value", { field: "CONF", values: [1] }, BAD_VALUE],
  ["empty-string value", { field: "CONF", values: ["Y", ""] }, BAD_VALUE],
  ["value with a line break", { field: "CONF", values: ["Y\nN"] }, BAD_VALUE],
  ["undefined element", { field: "CONF", values: [undefined] }, BAD_VALUE],
  ["hole before a good value", { field: "CONF", values: [, "Y"] }, BAD_VALUE],
  // JavaScript uppercases "ß" to "SS" and the dotless "ı" to "I"; a database
  // may not, so neither is enforceable as written.
  ["sharp s", { field: "CONF", values: ["ß"] }, BAD_VALUE],
  ["dotless i", { field: "CONF", values: ["ı"] }, BAD_VALUE],
  ["leading space", { field: "CONF", values: [" Y"] }, BAD_VALUE],
  ["LIKE bracket", { field: "CONF", values: ["["] }, BAD_VALUE],
  ["backslash", { field: "CONF", values: ["\\"] }, BAD_VALUE],
  ["percent", { field: "CONF", values: ["%"] }, BAD_VALUE],
  ["NEL", { field: "CONF", values: [String.fromCharCode(0x85)] }, BAD_VALUE],
  ["right-to-left override", { field: "CONF", values: [String.fromCharCode(0x202e)] }, BAD_VALUE],
  ["null flag", null, "the flag record is not an object"],
];

for (const [label, flag, problem] of MALFORMED_FLAGS) {
  test(`synthetic malformed flag (${label}): no owner query, no sample of either kind, the flag reported incomplete`, () => {
    const ep = {
      ...pagingEndpoint,
      sampleQuery: `${pagingEndpoint.url}/query?where=UPPER(OWNER_NAME)%20LIKE%20'%25SMITH%25'&f=json`,
      confidentialFlag: flag,
    };
    const p = ownerSearchPolicy({}, ep);
    assert.equal(p.kind, "confidential_flag_incomplete");
    assert.equal(p.field, null, "no owner column is offered");
    assert.equal(p.confidential?.kind, "incomplete");
    assert.equal(p.confidential.problem, problem);
    assert.match(p.reason, /flag record is incomplete/);
    assert.equal(buildArcgisOwnerQuery(ep, p, "SMITH"), "", "build_owner_query gets no URL");
    assert.throws(() => ownerWhereClause("OWNER_NAME", null, "SMITH", p.confidential), /confidential flag is incomplete/);
    assert.deepEqual(parcelEndpointSamples(ep, p), { atlas: null, owner: null }, "get_parcel_endpoint prints neither sample");
    assert.match(confidentialLine(p), /^Confidential flag: present but incomplete \(/);
    assert.match(confidentialLine(p), /do not read owner fields here$/);
    assert.equal(ownerCoverageLabel({ endpoints: [ep] }), "APN only (confidential flag incomplete)");
  });
}

test("CONTROL: an ASCII letters-and-digits value list is well formed", () => {
  for (const values of [["Y"], ["T"], ["1"], ["y", "SEALED", "007"]]) {
    assert.equal(confidentialExclusion({ field: "CONF", values })?.kind, "exclude", JSON.stringify(values));
  }
});

// A refusal that sends the caller to another read (by location, parcel id or
// address) must carry the flag line, and its advice must agree with it: a
// well-formed flag adds the rule the read must follow, and an incomplete one
// replaces the read with "do not read owner fields on this layer".
const FLAG_GOOD = { field: "CONF", values: ["Y"] };
const FLAG_BAD = { field: "CONF", values: [] };
const GOOD_FLAG_LINE =
  "Confidential flag: UPPER(CAST(CONF AS VARCHAR(255))) NOT LIKE '%Y%' (the county flags confidential owners in CONF; AND this into every query, and never show or pass on a flagged row)";
const BAD_FLAG_LINE =
  "Confidential flag: present but incomplete (the flag lists no values): no exclusion can be built, so no owner query is offered on this layer; do not read owner fields here";
const ROW_RULE =
  "request CONF in outFields and drop every row whose CONF cell is NULL or contains Y in any letter case; never show or pass on such a row";
const NO_READ =
  "The layer's confidential-owner flag is incomplete, so no read can keep flagged owners out: do not read owner fields on this layer";
const NO_ATTRIBUTE_SEARCH = { attributeSearch: "unsupported", searchFields: OWNER_FIELDS };
const UNSEARCHABLE = { searchFields: [{ name: "OWNER_NAME", label: "Owner", searchable: false }] };

const REFUSING_ENDPOINTS = [
  [
    "attribute search unsupported",
    NO_ATTRIBUTE_SEARCH,
    {
      none: "No where-clause query is possible here. Query the layer by location (a point or envelope geometry) to read the owner fields of the parcels there.",
      good: `No where-clause query is possible here. To read owner fields, query the layer by location (a point or envelope geometry). It takes no where clause, so the exclusion below cannot be ANDed in: ${ROW_RULE}.`,
      bad: `No where-clause query is possible here. ${NO_READ}, by location or otherwise.`,
    },
    "to read the owner fields of the parcels there",
    // This layer takes no where clause, so its flag line gives the row rule
    // rather than "AND this into every query".
    `Confidential flag: UPPER(CAST(CONF AS VARCHAR(255))) NOT LIKE '%Y%' (the county flags confidential owners in CONF; this layer takes no where clause, so ${ROW_RULE})`,
  ],
  [
    "owner unsearchable",
    UNSEARCHABLE,
    {
      none: "Use a parcel-id or location query instead; either returns the owner of the matching parcel.",
      good: `Use a parcel-id or location query instead; either returns the owner of the matching parcel. AND the exclusion below into its where, and ${ROW_RULE}.`,
      bad: `${NO_READ}, by parcel id, location or otherwise.`,
    },
    "either returns the owner",
    GOOD_FLAG_LINE,
  ],
];

for (const [label, base, advice, unflaggedAdvice, goodFlagLine] of REFUSING_ENDPOINTS) {
  for (const [state, flag, flagLine] of [
    ["no flag", undefined, null],
    ["well-formed flag", FLAG_GOOD, goodFlagLine],
    ["incomplete flag", FLAG_BAD, BAD_FLAG_LINE],
  ]) {
    test(`build_owner_query refusal (${label}, ${state}): the advice agrees with the flag, and the flag line follows`, () => {
      const ep = flag ? { ...base, confidentialFlag: flag } : base;
      const lines = ownerRefusal(ownerSearchPolicy({}, ep), "Somewhere, Texas").split("\n");
      const key = flag === undefined ? "none" : flag === FLAG_GOOD ? "good" : "bad";
      assert.equal(lines[1], advice[key]);
      if (flagLine) {
        assert.equal(lines[2], flagLine);
        assert.equal(lines.length, 3);
      } else {
        assert.equal(lines.length, 2, "CONTROL: no flag, no line");
      }
      if (key === "bad") {
        assert.ok(!lines.join("\n").includes(unflaggedAdvice), "an incomplete flag offers no read at all");
      }
    });
  }
}

test("build_owner_query refusal (no owner column) carries the flag line after its one-line note", () => {
  const base = { searchFields: [{ name: "PIN", label: "Parcel", searchable: true }] };
  const note = "Note: this layer publishes no owner or taxpayer column - PIN-only lookup. Try searching by parcel number instead.";
  assert.equal(ownerRefusal(ownerSearchPolicy({}, base), "X"), note);
  assert.equal(ownerRefusal(ownerSearchPolicy({}, { ...base, confidentialFlag: FLAG_GOOD }), "X"), `${note}\n${GOOD_FLAG_LINE}`);
  assert.equal(ownerRefusal(ownerSearchPolicy({}, { ...base, confidentialFlag: FLAG_BAD }), "X"), `${note}\n${BAD_FLAG_LINE}`);
});

test("the Owner line find_county and get_parcel_endpoint print agrees with the flag on both refusing kinds", () => {
  const line = (base, flag) => ownerLine(ownerSearchPolicy({}, flag ? { ...base, confidentialFlag: flag } : base));
  const reason = ownerSearchPolicy({}, NO_ATTRIBUTE_SEARCH).reason;
  const attr = `Attribute search: not offered (location queries only) - ${reason}`;
  assert.equal(line(NO_ATTRIBUTE_SEARCH), attr);
  assert.equal(line(NO_ATTRIBUTE_SEARCH, FLAG_GOOD), `${attr}; a location query takes no where clause, so ${ROW_RULE}`);
  assert.equal(line(NO_ATTRIBUTE_SEARCH, FLAG_BAD), `${attr}; the confidential flag is incomplete, so do not read owner fields here`);
  assert.equal(line(UNSEARCHABLE), "Owner field: not searchable by name (column exists; use a parcel-id or location query)");
  assert.equal(
    line(UNSEARCHABLE, FLAG_GOOD),
    `Owner field: not searchable by name (column exists; use a parcel-id or location query, AND the Confidential flag clause into its where, and ${ROW_RULE})`,
  );
  assert.equal(
    line(UNSEARCHABLE, FLAG_BAD),
    "Owner field: not searchable by name (column exists, but the confidential flag is incomplete, so do not read owner fields here)",
  );
  // Several values, any case in the record: each is named, uppercased.
  assert.match(
    line(UNSEARCHABLE, { field: "CONF", values: ["y", "sealed"] }),
    /drop every row whose CONF cell is NULL or contains Y or SEALED in any letter case;/,
  );
});

test("a reviewed not-published refusal carries the confidential line too", () => {
  const reviewed = {
    capabilityOverrides: { owner_name: { status: "not_published", basis: { type: "county_policy", note: "withheld" } } },
  };
  const ep = { searchFields: OWNER_FIELDS, confidentialFlag: { field: "CONF", values: [] } };
  const text = ownerRefusal(ownerSearchPolicy(reviewed, ep), "Somewhere, Texas");
  assert.match(text, /^OWNER NAME NOT AVAILABLE for Somewhere, Texas: withheld\n/);
  assert.match(text, /\nConfidential flag: present but incomplete \(the flag lists no values\)/);
});

test("CONTROL: an endpoint with no flag keeps the atlas sample, and a well-formed flag withholds it", () => {
  const sampleQuery = `${pagingEndpoint.url}/query?where=1%3D1&f=json`;
  const plain = { ...pagingEndpoint, sampleQuery };
  const plainSamples = parcelEndpointSamples(plain, ownerSearchPolicy({}, plain));
  assert.equal(plainSamples.atlas, sampleQuery);
  assert.equal(
    new URL(plainSamples.owner).searchParams.get("where"),
    "UPPER(OWNER_NAME) LIKE UPPER('%SMITH%')",
  );
  const flagged = { ...plain, confidentialFlag: { field: "CONF", values: ["Y"] } };
  const flaggedSamples = parcelEndpointSamples(flagged, ownerSearchPolicy({}, flagged));
  assert.equal(flaggedSamples.atlas, null);
  assert.equal(
    new URL(flaggedSamples.owner).searchParams.get("where"),
    "(UPPER(OWNER_NAME) LIKE UPPER('%SMITH%')) AND UPPER(CAST(CONF AS VARCHAR(255))) NOT LIKE '%Y%'",
  );
});

// The clause is SQL, so a SQL engine judges it rather than a reading of the
// string: node:sqlite runs the generated predicate over each layer's measured
// cell shapes. A NULL cell must drop out (flagged), and so must every flagged
// shape. SQLite's LIKE ignores ASCII case by default, so the case test below
// turns on case_sensitive_like, the shape of a backend that compares case.
const { DatabaseSync } = await import("node:sqlite");

function kept(confidential, type, cells, { caseSensitive = false } = {}) {
  const db = new DatabaseSync(":memory:");
  if (caseSensitive) db.exec("PRAGMA case_sensitive_like = ON");
  db.exec(`CREATE TABLE t (${confidential.field} ${type})`);
  const insert = db.prepare("INSERT INTO t VALUES (?)");
  for (const c of cells) insert.run(c);
  return db.prepare(`SELECT ${confidential.field} AS v FROM t WHERE ${confidential.where}`).all().map((r) => r.v);
}

test("SQL: Harris keeps 'NNNNNNNNNN', 'N         ' and the all-space blank; drops 'YNNNNNNNNN', 'Y         ' and NULL", () => {
  const harris = county("texas", "tx-harris");
  const { confidential } = ownerSearchPolicy(harris, harris.endpoints[0]);
  assert.deepEqual(
    kept(confidential, "TEXT", ["YNNNNNNNNN", "Y         ", "NNNNNNNNNN", "N         ", "          ", "NNNNYNNNNN", null]),
    ["NNNNNNNNNN", "N         ", "          "],
  );
});

test("SQL: Collin keeps 'F'; drops 'T' and NULL", () => {
  const collin = county("texas", "tx-collin");
  const { confidential } = ownerSearchPolicy(collin, collin.endpoints[0]);
  assert.deepEqual(kept(confidential, "TEXT", ["T", "F", null]), ["F"]);
});

test("SQL: Ector's integer cell is read as text: 0 kept; 1, 10 and NULL dropped", () => {
  const ector = county("texas", "tx-ector");
  const { confidential } = ownerSearchPolicy(ector, ector.endpoints[0]);
  assert.deepEqual(kept(confidential, "INTEGER", [0, 1, 10, null]), [0]);
});

test("SQL, case-sensitive LIKE: Harris still drops a lowercase 'ynnnnnnnnn', and a synthetic 'Sealed' drops every cell containing it", () => {
  // The control first: the pragma does make LIKE compare case here.
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA case_sensitive_like = ON");
  assert.equal(db.prepare("SELECT 'y' LIKE '%Y%' AS m").get().m, 0, "case_sensitive_like is on");
  const harris = county("texas", "tx-harris");
  const { confidential } = ownerSearchPolicy(harris, harris.endpoints[0]);
  assert.deepEqual(
    kept(confidential, "TEXT", ["ynnnnnnnnn", "nnnnYnnnnn", "nnnnnnnnnn", null], { caseSensitive: true }),
    ["nnnnnnnnnn"],
  );
  const sealed = confidentialExclusion({ field: "CONF", values: ["Sealed"] });
  // Contains, not equality: " SEALED" and "UNSEALED" drop out too, which is
  // more than the atlas's trimmed-equality rule would drop (fail-closed).
  assert.deepEqual(
    kept(sealed, "TEXT", ["sealed", "SEALED", " SEALED", "UNSEALED", "open", null], { caseSensitive: true }),
    ["open"],
  );
});
