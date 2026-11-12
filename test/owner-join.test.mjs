/**
 * Tests for the owner join (src/owner-join.ts and its use in
 * src/search-policy.ts and src/server.ts): a county whose owners sit in a
 * separate TABLE of its parcel service, joined to the parcel layer on a key.
 *
 * The bundled atlas carries no such record yet (Sussex County DE arrives in
 * atlas 0.9.1), so the records are fixtures shaped like it, built in
 * ./owner-join-fixture.mjs. Nothing is fetched: this server builds URLs, and
 * the row-reading rules are exercised on rows written here.
 *
 * Runs against the BUILT modules (dist/), the same bytes that ship, so build
 * first. The last section drives the built server over stdio with the
 * fixtures preloaded into the atlas package (./owner-join-preload.mjs), which
 * is what shows the tool handlers call the policy.
 *
 * Usage:  node --test test/owner-join.test.mjs
 * Or via: npm run test:policy
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { atlas } from "@urbankitstudio/atlas";
import {
  ownerSearchPolicy,
  ownerWhereClause,
  ownerCoverageLabel,
  buildArcgisOwnerQuery,
  ownerQueryRowsNote,
  ownerTableNotes,
  parcelEndpointSamples,
  ownerRefusal,
  ownerLine,
  OWNER_UNSEARCHABLE_REASON,
} from "../dist/search-policy.js";
import {
  usableOwnerJoin,
  ownerJoinOutFields,
  ownerJoinRowCap,
  ownerCellMatches,
  verifyOwnerEcho,
  readOwnerJoinRows,
} from "../dist/owner-join.js";
import {
  LAYER_URL,
  TABLE_URL,
  WIRE_LAYER_URL,
  JOINED_COUNTY_NAME,
  WIRE_COUNTY_NAME,
  ownerTable,
  joinedEndpoint,
  plainEndpoint,
  wireEndpoint,
} from "./owner-join-fixture.mjs";

const PIN_ONLY_NOTE =
  "Note: this layer publishes no owner or taxpayer column - PIN-only lookup. Try searching by parcel number instead.";
const OUT_FIELDS = ["PIN", "FULLNAME", "Second_Owner_Name", "MAILINGADDRESS", "CITY", "STATE", "ZIPCODE"];
const SMITH_TABLE_QUERY =
  `${TABLE_URL}/query?where=UPPER(FULLNAME)%20LIKE%20UPPER('%25SMITH%25')` +
  `&outFields=PIN,FULLNAME,Second_Owner_Name,MAILINGADDRESS,CITY,STATE,ZIPCODE` +
  `&orderByFields=OBJECTID_1&returnGeometry=false&f=json&resultRecordCount=25`;

// ---------------------------------------------------------------------------
// The policy: the owner column is found on the table
// ---------------------------------------------------------------------------

test("a joined record is offered an owner query on its table, never the PIN-only refusal", () => {
  const ep = joinedEndpoint();
  const p = ownerSearchPolicy({}, ep);
  assert.deepEqual(p, {
    kind: "offered",
    field: "FULLNAME",
    reason: null,
    scopeWhere: null,
    confidential: null,
    join: ep.ownerJoin,
  });
  assert.equal(ownerCoverageLabel({ endpoints: [ep] }), "owner+APN");
  assert.notEqual(buildArcgisOwnerQuery(ep, p, "SMITH"), "", "build_owner_query gets a URL");
  assert.ok(!ownerLine(p).includes("NONE"), ownerLine(p));

  // CONTROL: the same layer without its table is the PIN-only layer 0.3.12 saw.
  const plain = plainEndpoint();
  const q = ownerSearchPolicy({}, plain);
  assert.equal(q.kind, "no_owner_column");
  assert.equal(q.join, null);
  assert.equal(ownerRefusal(q, "Somewhere, Delaware"), PIN_ONLY_NOTE);
  assert.equal(ownerCoverageLabel({ endpoints: [plain] }), "APN only");
});

test("the layer's own owner column wins: a record that documents one keeps its layer query, join or not", () => {
  const searchFields = [
    { name: "Name", label: "PIN", searchable: true },
    { name: "OWNER", label: "Owner", searchable: true },
  ];
  const ep = joinedEndpoint({ searchFields });
  const p = ownerSearchPolicy({}, ep);
  assert.equal(p.field, "OWNER");
  assert.equal(p.join, null);
  const url = buildArcgisOwnerQuery(ep, p, "SMITH");
  assert.ok(url.startsWith(`${LAYER_URL}/query?`), url);
  assert.ok(!url.includes("orderByFields"), url);
  // An unsearchable owner column on the layer is the layer's refusal, with its own advice.
  const hidden = joinedEndpoint({ searchFields: [searchFields[0], { ...searchFields[1], searchable: false }] });
  const h = ownerSearchPolicy({}, hidden);
  assert.equal(h.kind, "owner_unsearchable");
  assert.equal(h.join, null);
  assert.equal(ownerLine(h), "Owner field: not searchable by name (column exists; use a parcel-id or location query)");
});

test("a table whose owner columns are all unsearchable is refused with the table named, not sent to the layer", () => {
  const fields = ownerTable().fields.map((f) => (/Owner/.test(f.label) ? { ...f, searchable: false } : f));
  const ep = joinedEndpoint({ ownerJoin: ownerTable({ fields }) });
  const p = ownerSearchPolicy({}, ep);
  assert.equal(p.kind, "owner_unsearchable");
  assert.equal(p.field, null);
  assert.equal(p.reason, OWNER_UNSEARCHABLE_REASON);
  assert.equal(p.join, ep.ownerJoin);
  assert.equal(buildArcgisOwnerQuery(ep, p, "SMITH"), "");
  assert.deepEqual(ownerTableNotes(p, ep), []);
  assert.equal(
    ownerRefusal(p, "Somewhere, Delaware"),
    `OWNER COLUMN NOT SEARCHABLE BY NAME for Somewhere, Delaware: ${OWNER_UNSEARCHABLE_REASON}\n` +
      `The owner column is in the county's owner table (${TABLE_URL}), not on the parcel layer, so a parcel-id or location query on the layer returns no owner. No owner query is offered here.`,
  );
  assert.equal(
    ownerLine(p),
    "Owner field: not searchable by name (column exists in the county's owner table, not on this layer; a parcel-id or location query here returns no owner)",
  );
  assert.equal(ownerCoverageLabel({ endpoints: [ep] }), "APN only (owner column not searchable)");
});

// ---------------------------------------------------------------------------
// The query: the table, by attribute, in a stable order
// ---------------------------------------------------------------------------

test("the owner query goes to the table URL, never the layer, and carries no geometry parameter", () => {
  const ep = joinedEndpoint();
  const raw = buildArcgisOwnerQuery(ep, ownerSearchPolicy({}, ep), "SMITH");
  assert.equal(raw, SMITH_TABLE_QUERY);
  assert.ok(raw.startsWith(`${TABLE_URL}/query?`), raw);
  assert.ok(!raw.startsWith(LAYER_URL), raw);
  const url = new URL(raw);
  assert.deepEqual(
    [...url.searchParams.keys()],
    ["where", "outFields", "orderByFields", "returnGeometry", "f", "resultRecordCount"],
    "an attribute query and nothing else",
  );
  for (const spatial of ["geometry", "geometryType", "spatialRel", "inSR", "distance", "units"]) {
    assert.equal(url.searchParams.has(spatial), false, spatial);
  }
  assert.equal(url.searchParams.get("returnGeometry"), "false");
  assert.equal(url.searchParams.get("where"), "UPPER(FULLNAME) LIKE UPPER('%SMITH%')");
});

test("the table query is ordered by the join's orderField and pages as every paging layer does", () => {
  const ep = joinedEndpoint({ ownerJoin: ownerTable({ orderField: "ROW_SEQ" }) });
  const url = new URL(buildArcgisOwnerQuery(ep, ownerSearchPolicy({}, ep), "SMITH"));
  assert.equal(url.searchParams.get("orderByFields"), "ROW_SEQ");
  assert.equal(url.searchParams.get("resultRecordCount"), "25");
  assert.equal(url.searchParams.has("resultOffset"), false, "the first page carries no offset");
  assert.equal(ownerQueryRowsNote(ep), "Returns up to 25 records");
});

test("the table query asks for the parcel key and the owner and mailing columns, not the row label", () => {
  const join = ownerTable();
  assert.deepEqual(ownerJoinOutFields(join, "FULLNAME"), OUT_FIELDS);
  // A table column the registry marks unsearchable is not requested, the key always is.
  const fields = join.fields.map((f) => (f.name === "PIN" || f.name === "ZIPCODE" ? { ...f, searchable: false } : f));
  assert.deepEqual(
    ownerJoinOutFields(ownerTable({ fields }), "FULLNAME"),
    OUT_FIELDS.filter((f) => f !== "ZIPCODE"),
  );
});

test("an owner name cannot leave the SQL literal on the table query either", () => {
  const ep = joinedEndpoint();
  const p = ownerSearchPolicy({}, ep);
  const where = new URL(buildArcgisOwnerQuery(ep, p, "O'NEIL') OR 1=1 --")).searchParams.get("where");
  assert.equal(where, "UPPER(FULLNAME) LIKE UPPER('%O''NEIL'') OR 1=1 --%')");
  assert.equal(where, ownerWhereClause(p.field, p.scopeWhere, "O'NEIL') OR 1=1 --", p.confidential));
});

// ---------------------------------------------------------------------------
// Reading the rows: the owner echo, the dedupe, the row cap
// ---------------------------------------------------------------------------

const feature = (attributes) => ({ attributes });
const MAILING = { Second_Owner_Name: null, MAILINGADDRESS: "1 EXAMPLE ST", CITY: "ANYTOWN", STATE: "DE", ZIPCODE: "19900" };
const row = (pin, owner, extra = {}) => feature({ PIN: pin, FULLNAME: owner, ...MAILING, ...extra });
const read = (features, join = ownerTable(), name = "SMITH") => readOwnerJoinRows(join, "FULLNAME", name, features);

test("integrity: one stray row whose owner does not hold the searched name refuses the whole response", () => {
  const honest = [row("1-00", "SMITH EXAMPLE A"), row("2-00", "BLACKSMITH EXAMPLE LLC")];
  // CONTROL: the honest rows alone are read, one key each.
  const ok = read(honest);
  assert.equal(ok.ok, true);
  assert.deepEqual([...ok.byKey.keys()], ["1-00", "2-00"]);
  assert.deepEqual(ok.byKey.get("1-00"), { state: "joined", rows: [honest[0].attributes] });

  const refused = read([...honest, row("3-00", "JONES EXAMPLE B")]);
  assert.deepEqual(refused, { ok: false, reason: "join-integrity" }, "no row of the response is handed back");
});

test("integrity: a table that ignored the where clause is refused wherever the stray row sits", () => {
  const stray = row("9-00", "UNRELATED EXAMPLE OWNER");
  const match = row("1-00", "SMITH EXAMPLE A");
  for (const features of [[stray], [stray, match], [match, stray, match]]) {
    assert.deepEqual(read(features), { ok: false, reason: "join-integrity" });
  }
  assert.equal(verifyOwnerEcho([stray.attributes, match.attributes], "FULLNAME", "SMITH"), false);
  assert.equal(verifyOwnerEcho([match.attributes], "FULLNAME", "SMITH"), true, "CONTROL");
  assert.equal(read([]).ok, true, "CONTROL: no rows is an honest empty answer");
});

test("integrity: a row with no owner cell, a blank owner or no attributes fails the echo", () => {
  const match = row("1-00", "SMITH EXAMPLE A");
  for (const bad of [
    row("2-00", null),
    row("2-00", ""),
    row("2-00", 12345),
    feature({ PIN: "2-00" }),
    feature(null),
    {},
    null,
    "SMITH",
  ]) {
    assert.deepEqual(read([match, bad]), { ok: false, reason: "join-integrity" });
  }
  // The echo reads the column that was searched, not another owner column of the row.
  const second = row("2-00", "JONES EXAMPLE B", { Second_Owner_Name: "SMITH EXAMPLE A" });
  assert.deepEqual(read([match, second]), { ok: false, reason: "join-integrity" });
});

test("the echo is the predicate that was sent: any case, a partial match, LIKE wildcards, accents folded", () => {
  assert.equal(ownerCellMatches("Smith Example A", "SMITH"), true);
  assert.equal(ownerCellMatches("BLACKSMITH EXAMPLE LLC", "smith"), true);
  assert.equal(ownerCellMatches("JONES EXAMPLE B", "SMITH"), false);
  assert.equal(ownerCellMatches("SMITH", "SMITH EXAMPLE"), false, "the cell must hold the whole searched name");
  // % and _ are wildcards on the county's server, so they are wildcards here.
  assert.equal(ownerCellMatches("SMYTH EXAMPLE", "SM_TH"), true);
  assert.equal(ownerCellMatches("SMTH EXAMPLE", "SM_TH"), false);
  assert.equal(ownerCellMatches("SMITH AND EXAMPLE", "SMITH%EXAMPLE"), true);
  assert.equal(ownerCellMatches("EXAMPLE AND SMITH", "SMITH%EXAMPLE"), false);
  assert.equal(ownerCellMatches("A.B (C) [D] * E", "(C) [D] *"), true, "other punctuation is literal");
  assert.equal(ownerCellMatches("JOSÉ EXAMPLE", "jose"), true);
  assert.equal(ownerCellMatches("JOSE EXAMPLE", "JOSÉ"), true);
  for (const notText of [null, undefined, 7, {}, ["SMITH"]]) assert.equal(ownerCellMatches(notText, "SMITH"), false);
});

test("dedupe: rows of one key that serve the same owner and mailing values are one row, whatever their row label", () => {
  const features = [
    row("1-00", "SMITH EXAMPLE A", { PINWASSEMENTUNIT: "1-00-1", OBJECTID_1: 11, a_account: "A1" }),
    row("1-00", "SMITH EXAMPLE A", { PINWASSEMENTUNIT: "1-00-2", OBJECTID_1: 12, a_account: "A2" }),
    row("1-00", "smith example a ", { PINWASSEMENTUNIT: "1-00-3", MAILINGADDRESS: " 1 example st" }),
    row("1-00", "SMITH EXAMPLE A", { PINWASSEMENTUNIT: "1-00-4", Second_Owner_Name: "" }),
    row("1-00", "SMITH EXAMPLE A", { MAILINGADDRESS: "9 OTHER RD" }),
    row("2-00", "SMITH EXAMPLE A"),
  ];
  const result = read(features);
  assert.equal(result.ok, true);
  const one = result.byKey.get("1-00");
  assert.equal(one.state, "joined");
  // Five rows, two served records: the first four differ only in what is not
  // served (the row label, the object id, an account), in case or in padding.
  assert.deepEqual(one.rows.map((r) => r.MAILINGADDRESS), ["1 EXAMPLE ST", "9 OTHER RD"]);
  assert.deepEqual(Object.keys(one.rows[0]), OUT_FIELDS, "a column that was not asked for is dropped from the row");
  // The same content under another key is that key's own row.
  assert.deepEqual(result.byKey.get("2-00"), { state: "joined", rows: [features[5].attributes] });
});

test("cap: a key with more different rows than maxRowsPerKey is withheld, and the other keys are still read", () => {
  const owners = (pin, n) => Array.from({ length: n }, (_, i) => row(pin, `SMITH EXAMPLE ${i + 1}`));
  const join = ownerTable();
  assert.equal(ownerJoinRowCap(join), 3, "fixture: the cap");
  const result = read([...owners("1-00", 3), ...owners("2-00", 4), ...owners("3-00", 1)], join);
  assert.equal(result.ok, true);
  assert.equal(result.byKey.get("1-00").state, "joined", "CONTROL: exactly the cap is served");
  assert.equal(result.byKey.get("1-00").rows.length, 3);
  assert.deepEqual(result.byKey.get("2-00"), { state: "ambiguous", count: 4 }, "over the cap: none of its rows");
  assert.equal(result.byKey.get("3-00").rows.length, 1);
  // The cap counts what is left after the dedupe: four rows, three records.
  const repeated = read([...owners("4-00", 3), row("4-00", "SMITH EXAMPLE 1")], join);
  assert.equal(repeated.byKey.get("4-00").state, "joined");
  assert.equal(repeated.byKey.get("4-00").rows.length, 3);
});

test("cap: without multiple rows a key with two different owners has no single owner", () => {
  const single = ownerTable({ multiple: undefined, maxRowsPerKey: undefined });
  assert.equal(ownerJoinRowCap(single), 1);
  const result = read(
    [row("1-00", "SMITH EXAMPLE A"), row("1-00", "SMITH EXAMPLE B"), row("2-00", "SMITH EXAMPLE A"), row("2-00", "SMITH EXAMPLE A")],
    single,
  );
  assert.deepEqual(result.byKey.get("1-00"), { state: "ambiguous", count: 2 });
  assert.equal(result.byKey.get("2-00").state, "joined", "two rows, one record");
  // A ceiling that is not a positive integer, or one without multiple, is 1.
  for (const overrides of [{ maxRowsPerKey: 0 }, { maxRowsPerKey: 2.5 }, { maxRowsPerKey: "3" }, { multiple: undefined }]) {
    assert.equal(ownerJoinRowCap(ownerTable(overrides)), 1, JSON.stringify(overrides));
  }
});

test("a matching row with no usable key is tied to no parcel: counted, not served", () => {
  const result = read([
    row("1-00", "SMITH EXAMPLE A"),
    row("  ", "SMITH EXAMPLE B"),
    row(null, "SMITH EXAMPLE C"),
    row(2 ** 53, "SMITH EXAMPLE D"),
    row(" 2-00 ", "SMITH EXAMPLE E"),
    row(300, "SMITH EXAMPLE F"),
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.unkeyed, 3);
  assert.deepEqual([...result.byKey.keys()], ["1-00", "2-00", "300"], "a key is trimmed, nothing else");
});

// ---------------------------------------------------------------------------
// When a join may not be used: the validator's J8, held again at run time
// ---------------------------------------------------------------------------

const restricted = (field) => ({
  capabilityOverrides: { [field]: { status: "restricted", basis: { type: "county_policy", note: "The county withholds it." } } },
});
const withWireName = (fields, name) => fields.map((f) => (f.name === name ? { ...f, wireName: `SDE.t.${name}` } : f));
const COMPANIONS = [
  ["the county restricts the owner mailing address", restricted("owner_mailing_address"), {}],
  ["the county restricts the owner name", restricted("owner_name"), {}],
  ["scopeWhere", {}, { scopeWhere: "CNTY=5" }],
  ["sharedService", {}, { sharedService: true }],
  ["confidentialFlag", {}, { confidentialFlag: { field: "CONF", values: ["Y"], safeValues: ["N"] } }],
  ["supportsPagination false", {}, { supportsPagination: false, maxRecordCount: 1000 }],
  ["attributeSearch unsupported", {}, { attributeSearch: "unsupported" }],
  ["a wireName on the layer", {}, { searchFields: withWireName(joinedEndpoint().searchFields, "Name") }],
  ["a wireName on the table", {}, { ownerJoin: ownerTable({ fields: withWireName(ownerTable().fields, "FULLNAME") }) }],
];

test("CONTROL: the fixture with none of the J8 companions is a usable join", () => {
  const ep = joinedEndpoint();
  assert.equal(usableOwnerJoin({}, ep), ep.ownerJoin);
  assert.equal(ownerSearchPolicy({}, ep).join, ep.ownerJoin);
});

for (const [label, county, overrides] of COMPANIONS) {
  test(`J8 companion (${label}): the join is not used and the record is served as its plain layer`, () => {
    const ep = joinedEndpoint(overrides);
    const plain = plainEndpoint(overrides);
    assert.ok(ep.ownerJoin, "fixture: the record carries a join");
    assert.equal(plain.ownerJoin, undefined, "fixture: the plain twin carries none");
    assert.equal(usableOwnerJoin(county, ep), null);
    const p = ownerSearchPolicy(county, ep);
    const q = ownerSearchPolicy(county, plain);
    assert.equal(p.join, null);
    assert.equal(p.field, null, "the layer documents no owner column, so none is offered");
    assert.deepEqual(p, q, "the policy of the same record without its ownerJoin");
    assert.equal(buildArcgisOwnerQuery(ep, p, "SMITH"), "", "no query, so the table is never asked");
    assert.deepEqual(ownerTableNotes(p, ep), []);
    const text = [ownerLine(p), ownerRefusal(p, "Somewhere, Delaware")].join("\n");
    assert.equal(text, [ownerLine(q), ownerRefusal(q, "Somewhere, Delaware")].join("\n"));
    assert.ok(!text.includes(TABLE_URL), "the table is not named");
    assert.equal(ownerCoverageLabel({ ...county, endpoints: [ep] }), ownerCoverageLabel({ ...county, endpoints: [plain] }));
  });
}

for (const [label, ownerJoin] of [
  ["no orderField", ownerTable({ orderField: undefined })],
  ["a blank url", ownerTable({ url: " " })],
  ["fields that are not a list", ownerTable({ fields: "PIN,FULLNAME" })],
  ["a field with no name", ownerTable({ fields: [...ownerTable().fields, { label: "Owner", searchable: true }] })],
  ["a key that is not one of its fields", ownerTable({ key: "PARCELNO" })],
  ["null", null],
]) {
  test(`a join record no query can be built from (${label}) is not used`, () => {
    const ep = joinedEndpoint({ ownerJoin });
    assert.equal(usableOwnerJoin({}, ep), null);
    const p = ownerSearchPolicy({}, ep);
    assert.equal(p.kind, "no_owner_column");
    assert.equal(p.join, null);
    assert.equal(buildArcgisOwnerQuery(ep, p, "SMITH"), "");
  });
}

// ---------------------------------------------------------------------------
// What an agent reads
// ---------------------------------------------------------------------------

test("the Owner line names the table and how its key ties to the layer", () => {
  const ep = joinedEndpoint();
  assert.equal(
    ownerLine(ownerSearchPolicy({}, ep)),
    `Owner field: FULLNAME (in the county's owner table ${TABLE_URL}, not on this layer; the table's PIN is this layer's Name)`,
  );
});

test("the notes under a table query give the reading rules readOwnerJoinRows holds, with the record's own names", () => {
  const ep = joinedEndpoint();
  const p = ownerSearchPolicy({}, ep);
  assert.deepEqual(ownerTableNotes(p, ep), [
    `The rows come from the county's owner table, not the parcel layer: each is one ownership record with no geometry, and its PIN is the parcel's Name on the parcel layer ${LAYER_URL}`,
    "Check every row before using any: each must hold the searched name in FULLNAME. If one does not, the table did not apply the where clause, so discard the whole response and show none of its owners",
    "Rows of one PIN that carry the same owner and mailing values are one ownership record, so keep one of them. A PIN left with more than 3 different rows has no owner you can state: show none of its rows",
    "For more rows add &resultOffset=25 (then 50, and so on) and keep orderByFields=OBJECTID_1, which holds the pages in one order",
  ]);
  // The numbers and names in the notes are the query's and the reader's own.
  const url = new URL(buildArcgisOwnerQuery(ep, p, "SMITH"));
  const notes = ownerTableNotes(p, ep).join("\n");
  assert.ok(notes.includes(`&resultOffset=${url.searchParams.get("resultRecordCount")} `));
  assert.ok(notes.includes(`orderByFields=${url.searchParams.get("orderByFields")},`));
  assert.ok(notes.includes(`more than ${ownerJoinRowCap(ep.ownerJoin)} different rows`));
  // Without multiple rows the cap is one, and the note says so.
  const single = joinedEndpoint({ ownerJoin: ownerTable({ multiple: undefined, maxRowsPerKey: undefined }) });
  assert.equal(
    ownerTableNotes(ownerSearchPolicy({}, single), single)[2],
    "Rows of one PIN that carry the same owner and mailing values are one ownership record, so keep one of them. A PIN left with more than one different row has no single owner: show none of its rows",
  );
});

test("get_parcel_endpoint's sample owner query on a joined record is the table query", () => {
  const ep = joinedEndpoint();
  const samples = parcelEndpointSamples(ep, ownerSearchPolicy({}, ep));
  assert.equal(samples.owner, SMITH_TABLE_QUERY);
  assert.equal(samples.atlas, ep.sampleQuery, "the atlas's own sample, a parcel-id query on the layer, stays");
});

// ---------------------------------------------------------------------------
// A record with no join behaves exactly as before
// ---------------------------------------------------------------------------

test("a join-less record's policy, request and texts are byte-identical to 0.3.12's", () => {
  const ep = {
    url: "https://gis.example.gov/arcgis/rest/services/P/MapServer/0",
    searchFields: [
      { name: "PARCEL_ID", label: "Parcel", searchable: true },
      { name: "OWNER_NAME", label: "Owner", searchable: true },
      { name: "MAIL_ADDR", label: "Mailing Address", searchable: true },
      { name: "LEGAL", label: "Legal Description", searchable: false },
    ],
  };
  const p = ownerSearchPolicy({}, ep);
  assert.deepEqual(p, { kind: "offered", field: "OWNER_NAME", reason: null, scopeWhere: null, confidential: null, join: null });
  assert.equal(
    buildArcgisOwnerQuery(ep, p, "SMITH"),
    "https://gis.example.gov/arcgis/rest/services/P/MapServer/0/query?where=UPPER(OWNER_NAME)%20LIKE%20UPPER('%25SMITH%25')&outFields=PARCEL_ID,OWNER_NAME,MAIL_ADDR&returnGeometry=false&f=json&resultRecordCount=25",
  );
  assert.equal(ownerLine(p), "Owner field: OWNER_NAME");
  assert.deepEqual(ownerTableNotes(p, ep), []);
});

test("every join-less endpoint of the installed atlas keeps the 0.3.12 request shape, and every joined one is asked at its table", () => {
  let plain = 0;
  let offered = 0;
  for (const stateFile of atlas.byStateSlug.values()) {
    for (const c of stateFile.counties) {
      for (const ep of c.endpoints) {
        const p = ownerSearchPolicy(c, ep);
        const url = buildArcgisOwnerQuery(ep, p, "SMITH");
        if (ep.ownerJoin !== undefined) {
          // A real joined record (none before atlas 0.9.1): never the layer.
          if (p.join) assert.ok(url.startsWith(`${p.join.url}/query?`) && url.includes("&orderByFields="), `${c.id}: ${url}`);
          continue;
        }
        plain++;
        assert.equal(p.join, null, c.id);
        assert.deepEqual(ownerTableNotes(p, ep), [], c.id);
        if (!p.field) {
          assert.equal(url, "", c.id);
          continue;
        }
        offered++;
        // The 0.3.12 request, re-derived here and never read back from the builder.
        const fields = ep.searchFields.filter((sf) => sf.searchable).map((sf) => sf.name);
        if (p.confidential?.kind === "exclude" && !fields.includes(p.confidential.field)) fields.push(p.confidential.field);
        const where = encodeURIComponent(ownerWhereClause(p.field, p.scopeWhere, "SMITH", p.confidential));
        const expected =
          `${ep.url}/query?where=${where}&outFields=${fields.join(",")}&returnGeometry=false&f=json` +
          (ep.supportsPagination === false ? "" : "&resultRecordCount=25");
        assert.equal(url, expected, c.id);
        assert.equal(ownerLine(p), `Owner field: ${p.field}`, c.id);
      }
    }
  }
  // CONTROL: the loop did read the registry.
  assert.ok(plain >= 500, `join-less endpoints read: ${plain}`);
  assert.ok(offered >= 350, `owner queries compared: ${offered}`);
});

// ---------------------------------------------------------------------------
// wireName: the column to send (forward-compatible; no record carries one yet)
// ---------------------------------------------------------------------------

test("a field with a wireName is sent by it, in the where clause and in outFields", () => {
  const ep = wireEndpoint();
  const p = ownerSearchPolicy({}, ep);
  assert.equal(p.field, "SDE.WEB_CAMA.OWNER_NAME1");
  assert.equal(ownerLine(p), "Owner field: SDE.WEB_CAMA.OWNER_NAME1");
  const url = new URL(buildArcgisOwnerQuery(ep, p, "SMITH"));
  assert.equal(url.searchParams.get("where"), "UPPER(SDE.WEB_CAMA.OWNER_NAME1) LIKE UPPER('%SMITH%')");
  assert.equal(url.searchParams.get("outFields"), "SDE.mc_parcel_polygon.TAXPINNO,SDE.WEB_CAMA.OWNER_NAME1");
  assert.ok(url.href.startsWith(`${WIRE_LAYER_URL}/query?`));
});

// ---------------------------------------------------------------------------
// The built server's tool handlers, over stdio, with the fixtures preloaded
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, "../dist/server.js");
const PRELOAD = pathToFileURL(resolve(HERE, "owner-join-preload.mjs")).href;

/** Start the built server with the fixture counties preloaded, and hand `run` a tool caller. */
async function withServer(run) {
  const proc = spawn(process.execPath, ["--import", PRELOAD, SERVER], { stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map();
  let buffer = "";
  let stderr = "";
  proc.stderr.on("data", (d) => {
    stderr += d;
  });
  proc.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });
  let nextId = 1;
  const request = (method, params) =>
    new Promise((done, fail) => {
      const id = nextId++;
      // Generous on purpose: a cold start on a busy machine has taken 7 s.
      const timer = setTimeout(() => fail(new Error(`no answer to ${method} within 30 s; server stderr: ${stderr}`)), 30_000);
      waiting.set(id, (message) => {
        clearTimeout(timer);
        done(message);
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  try {
    await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "owner-join-test", version: "0.0.0" },
    });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return await run(async (name, args) => (await request("tools/call", { name, arguments: args })).result?.content?.[0]?.text ?? "");
  } finally {
    proc.kill();
  }
}

const newCastle = () => {
  const c = atlas.byStateSlug.get("delaware")?.counties.find((x) => x.id === "de-new-castle");
  assert.ok(c, "registry fixture de-new-castle exists in the installed atlas");
  const p = ownerSearchPolicy(c, c.endpoints[0]);
  assert.ok(p.field && p.join === null, "CONTROL fixture: New Castle offers an owner query on its own layer");
  return { county: c, policy: p };
};

test("stdio server: build_owner_query on a joined county returns the table query and its reading notes", async () => {
  const ep = joinedEndpoint();
  const p = ownerSearchPolicy({}, ep);
  const notes = ownerTableNotes(p, ep);
  assert.equal(notes.length, 4, "fixture: the notes exist");
  await withServer(async (call) => {
    const text = await call("build_owner_query", { state: "DE", county: JOINED_COUNTY_NAME, owner_name: "SMITH" });
    const lines = text.split("\n");
    assert.ok(!text.includes("PIN-only"), text);
    assert.ok(lines.includes(`County:      ${JOINED_COUNTY_NAME}, Delaware`), text);
    assert.ok(lines.includes(ownerLine(p)), text);
    assert.ok(lines.includes("WHERE clause: UPPER(FULLNAME) LIKE UPPER('%SMITH%')"), text);
    assert.equal(lines[lines.indexOf("Query URL:") + 1], SMITH_TABLE_QUERY);
    assert.ok(!text.includes(`${LAYER_URL}/query`), "no query against the layer is printed");
    const first = lines.indexOf("  - Returns up to 25 records");
    assert.ok(first > 0, text);
    assert.deepEqual(lines.slice(first + 1, first + 1 + notes.length), notes.map((n) => `  - ${n}`));

    // CONTROL, same server: a join-less Delaware county keeps its plain answer.
    const { county, policy } = newCastle();
    const plain = await call("build_owner_query", { state: "DE", county: county.county, owner_name: "SMITH" });
    assert.ok(plain.split("\n").includes(`Owner field: ${policy.field}`), plain);
    assert.ok(plain.includes(buildArcgisOwnerQuery(county.endpoints[0], policy, "SMITH")), plain);
    assert.ok(!plain.includes("owner table") && !plain.includes("orderByFields") && !plain.includes("resultOffset"), plain);
  });
});

test("stdio server: get_parcel_endpoint, find_county and list_counties read a joined county as owner-searchable", async () => {
  const ep = joinedEndpoint();
  const p = ownerSearchPolicy({}, ep);
  await withServer(async (call) => {
    const record = await call("get_parcel_endpoint", { state: "DE", county: JOINED_COUNTY_NAME });
    const lines = record.split("\n");
    assert.ok(lines.includes(`  ${ownerLine(p)}`), record);
    assert.ok(lines.includes(`    ${SMITH_TABLE_QUERY}`), record);
    assert.ok(lines.includes(`    ${ep.sampleQuery}`), record);
    // The deep link opens the layer, which has no FULLNAME column to hint at.
    assert.equal(
      lines.find((l) => l.includes("UrbanKit deep-link:")),
      `  UrbanKit deep-link: https://urbankitstudio.com/tools/parcel-lookup?endpoint=${encodeURIComponent(LAYER_URL)}`,
    );

    const found = await call("find_county", { query: `${JOINED_COUNTY_NAME} DE` });
    assert.ok(found.split("\n").includes(`  ${ownerLine(p)}`), found);
    assert.ok(!found.includes("NONE - this layer publishes no owner column"), found);

    const listed = await call("list_counties", { state: "DE" });
    assert.match(listed, /\| Sussex Fixture\s+\| sussex-fixture-county\s+\| owner\+APN\n/);

    // CONTROL, same server: a join-less county keeps its field hint.
    const { county, policy } = newCastle();
    const plain = await call("get_parcel_endpoint", { state: "DE", county: county.county });
    assert.ok(plain.includes(`&fieldHint=${policy.field}`), plain);
    assert.ok(plain.split("\n").includes(`  Owner field: ${policy.field}`), plain);
  });
});

test("stdio server: the field lists print the name to send (a wireName where a record carries one)", async () => {
  await withServer(async (call) => {
    const record = await call("get_parcel_endpoint", { state: "DE", county: WIRE_COUNTY_NAME });
    const lines = record.split("\n");
    assert.ok(lines.includes("    SDE.mc_parcel_polygon.TAXPINNO – Parcel ID"), record);
    assert.ok(lines.includes("    SDE.WEB_CAMA.OWNER_NAME1 – Owner Name"), record);
    assert.ok(lines.includes("  Owner field: SDE.WEB_CAMA.OWNER_NAME1"), record);
    const found = await call("find_county", { query: `${WIRE_COUNTY_NAME} DE` });
    assert.ok(
      found.split("\n").includes("  Searchable fields: SDE.mc_parcel_polygon.TAXPINNO (Parcel ID), SDE.WEB_CAMA.OWNER_NAME1 (Owner Name)"),
      found,
    );
    // CONTROL, same server: a record with no wireName prints its names as before.
    const { county } = newCastle();
    const plain = await call("find_county", { query: `${county.county} DE` });
    const names = county.endpoints[0].searchFields.filter((sf) => sf.searchable).map((sf) => `${sf.name} (${sf.label})`);
    assert.ok(plain.split("\n").includes(`  Searchable fields: ${names.join(", ")}`), plain);
  });
});
