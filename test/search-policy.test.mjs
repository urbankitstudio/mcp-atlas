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
import { findState, reviewedCapability } from "@urbankitstudio/atlas";
import {
  ownerSearchPolicy,
  ownerWhereClause,
  ownerCoverageLabel,
  buildArcgisOwnerQuery,
  ownerQueryRowsNote,
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
    field: "confidential_flag",
    where: "CAST(confidential_flag AS VARCHAR(255)) NOT LIKE '%Y%'",
  });
  assert.equal(
    ownerWhereClause(p.field, p.scopeWhere, "SMITH", p.confidential),
    "(UPPER(owner_name_1) LIKE UPPER('%SMITH%')) AND CAST(confidential_flag AS VARCHAR(255)) NOT LIKE '%Y%'",
  );
  const url = new URL(buildArcgisOwnerQuery(ep, p, "SMITH"));
  assert.equal(
    url.searchParams.get("where"),
    "(UPPER(owner_name_1) LIKE UPPER('%SMITH%')) AND CAST(confidential_flag AS VARCHAR(255)) NOT LIKE '%Y%'",
  );
  assert.ok(url.searchParams.get("outFields").split(",").includes("confidential_flag"), "the flag column is requested");
});

test("Collin TX: a one-character 'T' is a contains test too", () => {
  const collin = county("texas", "tx-collin");
  const p = ownerSearchPolicy(collin, collin.endpoints[0]);
  assert.equal(
    ownerWhereClause(p.field, p.scopeWhere, "SMITH", p.confidential),
    "(UPPER(GIS_DBO_AD_Entity_file_as_name) LIKE UPPER('%SMITH%')) AND CAST(GIS_DBO_AD_Entity_confidential_ AS VARCHAR(255)) NOT LIKE '%T%'",
  );
  const url = new URL(buildArcgisOwnerQuery(collin.endpoints[0], p, "SMITH"));
  assert.ok(url.searchParams.get("outFields").split(",").includes("GIS_DBO_AD_Entity_confidential_"));
});

test("Ector TX: the small-integer conf_flg is cast to text, which its server accepts", () => {
  const ector = county("texas", "tx-ector");
  assert.deepEqual(ector.endpoints[0].confidentialFlag, { field: "conf_flg", values: ["1"] }, "fixture: the installed atlas's marker");
  const p = ownerSearchPolicy(ector, ector.endpoints[0]);
  assert.equal(p.confidential.where, "CAST(conf_flg AS VARCHAR(255)) NOT LIKE '%1%'");
  assert.equal(
    ownerWhereClause(p.field, p.scopeWhere, "SMITH", p.confidential),
    "(UPPER(owner_name) LIKE UPPER('%SMITH%')) AND CAST(conf_flg AS VARCHAR(255)) NOT LIKE '%1%'",
  );
});

// The URL-encoded where, pinned as the bytes the URL carries, so a change in
// the encoding (not only in the clause) fails too.
test("the three flagged owner query URLs carry these exact encoded where clauses and flag columns", () => {
  const expected = {
    "tx-harris": [
      "(UPPER(owner_name_1)%20LIKE%20UPPER('%25SMITH%25'))%20AND%20CAST(confidential_flag%20AS%20VARCHAR(255))%20NOT%20LIKE%20'%25Y%25'",
      "HCAD_NUM,acct_num,owner_name_1,owner_name_2,site_str_num,site_str_name,site_city,site_zip,mail_addr_1,confidential_flag",
    ],
    "tx-collin": [
      "(UPPER(GIS_DBO_AD_Entity_file_as_name)%20LIKE%20UPPER('%25SMITH%25'))%20AND%20CAST(GIS_DBO_AD_Entity_confidential_%20AS%20VARCHAR(255))%20NOT%20LIKE%20'%25T%25'",
      "GIS_DBO_AD_Entity_file_as_name,GIS_DBO_AD_Entity_situs_display,GIS_DBO_Parcel_PROP_ID,GIS_DBO_Parcel_GEO_ID,GIS_DBO_AD_Entity_confidential_",
    ],
    "tx-ector": [
      "(UPPER(owner_name)%20LIKE%20UPPER('%25SMITH%25'))%20AND%20CAST(conf_flg%20AS%20VARCHAR(255))%20NOT%20LIKE%20'%251%25'",
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
  let flagged = 0;
  for (const c of findState("texas").counties) {
    for (const ep of c.endpoints) {
      if (!ep.confidentialFlag) continue;
      flagged++;
      const p = ownerSearchPolicy(c, ep);
      assert.ok(p.confidential, `${c.id} reports its flag`);
      const where = new URL(buildArcgisOwnerQuery(ep, p, "SMITH")).searchParams.get("where");
      assert.ok(where.endsWith(`) AND ${p.confidential.where}`), `${c.id}: ${where}`);
    }
  }
  assert.ok(flagged >= 3, `the installed atlas flags at least Harris, Collin and Ector (saw ${flagged})`);
});

test("synthetic: a longer value is an equality test, several values AND together, the scope stays first", () => {
  const p = ownerSearchPolicy({}, {
    scopeWhere: "CNTY=7",
    confidentialFlag: { field: "CONF", values: ["Y", "SEALED"] },
    searchFields: OWNER_FIELDS,
  });
  assert.equal(
    ownerWhereClause(p.field, p.scopeWhere, "SMITH", p.confidential),
    "((CNTY=7) AND UPPER(OWNER_NAME) LIKE UPPER('%SMITH%')) AND CAST(CONF AS VARCHAR(255)) NOT LIKE '%Y%' AND CAST(CONF AS VARCHAR(255)) <> 'SEALED'",
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

test("synthetic: a flag column already among the searchable fields is not requested twice", () => {
  const ep = { ...pagingEndpoint, confidentialFlag: { field: "OWNER_NAME", values: ["Y"] } };
  const url = new URL(buildArcgisOwnerQuery(ep, ownerSearchPolicy({}, ep), "SMITH"));
  assert.equal(url.searchParams.get("outFields"), "OWNER_NAME");
});

// The clause is SQL, so a SQL engine judges it rather than a reading of the
// string: node:sqlite runs the generated predicate over each layer's measured
// cell shapes. A NULL cell must drop out (flagged), and so must every flagged
// shape. SQLite's LIKE ignores ASCII case, unlike some ArcGIS backends, so case
// is not what this proves; containment and NULL are.
const { DatabaseSync } = await import("node:sqlite");

function kept(confidential, type, cells) {
  const db = new DatabaseSync(":memory:");
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
