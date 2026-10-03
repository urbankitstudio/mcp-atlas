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

test("Orleans Parish: an owner column marked searchable:false is not offered", () => {
  const orleans = county("louisiana", "la-orleans-parish");
  assert.equal(ownerSearchPolicy(orleans, orleans.endpoints[0]).kind, "owner_unsearchable");
  assert.equal(ownerCoverageLabel(orleans), "APN only (owner column not searchable)");
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
