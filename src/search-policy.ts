/**
 * Owner-search policy: the ONE rule for whether this server offers an
 * owner-name query on a county endpoint, and how that query is scoped.
 *
 * Every tool (list_counties, find_county, get_parcel_endpoint,
 * build_owner_query) asks this module and nothing else, so no county can be
 * offered by one tool and refused by another. Written 2026-10-03 on Leo's
 * directive to surface as much of the county data as the registry knows,
 * with clean, commented SOLID/DRY/KISS code.
 *
 * Decision order, first match wins:
 *   1. reviewed_unservable: a human-reviewed capability record says the owner
 *      name cannot be served. New Jersey's statewide layer publishes OWNER_NAME
 *      blank on 3.4M rows; only the reviewed record can say so, and it outranks
 *      anything the field list implies.
 *   2. attribute_search_unsupported: the registry marks the layer
 *      `attributeSearch: "unsupported"`. It cannot answer a `where` on any
 *      column. In atlas 0.6.9 all 67 such endpoints are Florida's FDOR
 *      statewide layer. Owner and address values still come back from
 *      location queries, so the reason says that instead of "no owner".
 *   3. owner_unsearchable: an owner-name column exists but the county marks
 *      every such column `searchable: false`. A query on it hangs or errors
 *      (Orleans Parish OWNERNME1, where a column scan takes ~44 s). The owner
 *      is still returned by a parcel-id or location query.
 *   4. offered: the first owner-name column that is searchable (the column
 *      test is the UKS classifier's; see OWNER_RE below).
 *   5. no_owner_column: the layer documents no owner column at all.
 *
 * Separately from the branch, `scopeWhere` is returned whenever the registry
 * carries one. A shared statewide or regional layer holds every county's rows
 * (FDOR `CO_NO=23` is Miami-Dade), so an unscoped query returns the whole
 * state. ownerWhereClause ANDs the scope in front of every owner match.
 *
 * Likewise `confidential` is returned whenever the endpoint carries the
 * atlas's `confidentialFlag` (0.6.43): the county's own column marking an
 * owner whose record must not be shown (Texas Tax Code §25.025; Harris,
 * Collin and Ector). ownerWhereClause ANDs its exclusion after the owner
 * match, and buildArcgisOwnerQuery requests the column.
 */

import { isReviewedUnservable, offersPagination, reviewedCapability } from "@urbankitstudio/atlas";
import type { ConfidentialFlag, CountyRecord, EndpointRecord } from "@urbankitstudio/atlas";

/**
 * The endpoint fields this policy reads, as @urbankitstudio/atlas declares them
 * (`scopeWhere` and `attributeSearch` since 0.6.11; before that this file
 * carried a local copy of the two; `confidentialFlag` since 0.6.43).
 */
export type EndpointSearchPolicyFields = Pick<
  EndpointRecord,
  "searchFields" | "scopeWhere" | "attributeSearch" | "confidentialFlag"
>;

type CountyPolicyFields = Pick<CountyRecord, "capabilityOverrides">;

export type OwnerSearchKind =
  | "offered"
  | "reviewed_unservable"
  | "attribute_search_unsupported"
  | "owner_unsearchable"
  | "no_owner_column";

export interface OwnerSearchPolicy {
  kind: OwnerSearchKind;
  /** The owner column to query. Set only when kind is "offered". */
  field: string | null;
  /** Why no owner query is offered. Null when offered or when there is simply no owner column. */
  reason: string | null;
  /** SQL predicate scoping a shared layer to this county, or null. */
  scopeWhere: string | null;
  /** The layer's confidential-owner column and the predicate that keeps its flagged rows out, or null. */
  confidential: ConfidentialExclusion | null;
}

export interface ConfidentialExclusion {
  /** The flag column, requested with the owner so a reader can drop a flagged row too. */
  field: string;
  /** ANDed into every owner query. */
  where: string;
}

/**
 * The exclusion for a layer's confidential-owner flag, in the terms the atlas
 * gives (README "Some layers flag an owner's record confidential"): a
 * ONE-character value V is a flag when the cell CONTAINS it, so
 * `NOT LIKE '%V%'` (Harris packs one Y/N per ownership slot, "YNNNNNNNNN",
 * which an equality test would keep); a longer value is `<> 'V'`.
 *
 * The cell is CAST to text first. Ector's conf_flg is a small integer, and its
 * server answers `conf_flg NOT LIKE '%1%'` (and `<> '1'`) with HTTP 400, which
 * would break every Ector owner query; the cast form answers on all three
 * layers with the same counts as the bare form (measured 2026-10-25). The atlas
 * already reads the cell as text.
 *
 * NULL is FLAGGED, as the atlas requires of a row that lacks the column: a NULL
 * cell makes either comparison UNKNOWN, so the row drops out. Harris has 5,235
 * NULL cells and Collin 15,003, and both fall outside the clause live. Never
 * COALESCE the cell to '' here: that would serve them.
 */
export function confidentialExclusion(flag: ConfidentialFlag | undefined): ConfidentialExclusion | null {
  if (!flag || flag.values.length === 0) return null;
  const cell = `CAST(${flag.field} AS VARCHAR(255))`;
  const where = flag.values
    .map((v) =>
      v.length === 1
        ? `${cell} NOT LIKE '%${escapeSqlLiteral(v)}%'`
        : `${cell} <> '${escapeSqlLiteral(v)}'`,
    )
    .join(" AND ");
  return { field: flag.field, where };
}

// THE OWNER-COLUMN TEST, copied VERBATIM from the UKS canonical classifier:
// urbankitstudio/src/lib/enrich-core.ts lines 48 (OWNER_RE) and 58
// (OWNER_EXCLUDE), applied there by firstMatch to `${name} ${label}`. The two
// copies must stay byte-equal until @urbankitstudio/atlas exports the
// classifier (a queued UKS follow-up); then import it and delete these lines.
// Testing the label as well as the name is what makes Mahoning's
// "OWNNAME1 / Owner Name 1" an owner column. The exclude keeps owner ADDRESS
// and locale columns (OWNER_ADDR, OWNERCITY) from being offered as a name.
const OWNER_RE = /owner|taxpayer|tax.?name|grantor|\bown\b|ownnme|ownernme/i;
const OWNER_EXCLUDE = /addr|address|\bcity\b|\bstate\b|\bzip\b/i;

function isOwnerNameColumn(sf: { name: string; label: string }): boolean {
  const hay = `${sf.name} ${sf.label}`;
  return !OWNER_EXCLUDE.test(hay) && OWNER_RE.test(hay);
}

export const ATTRIBUTE_SEARCH_UNSUPPORTED_REASON =
  "this layer does not serve attribute searches; owner and address fields are answered only by location queries";
export const OWNER_UNSEARCHABLE_REASON =
  "the owner column exists but the county marks it unsearchable";

export function ownerSearchPolicy(
  county: CountyPolicyFields,
  endpoint: EndpointSearchPolicyFields,
): OwnerSearchPolicy {
  const scopeWhere = endpoint.scopeWhere?.trim() || null;
  const confidential = confidentialExclusion(endpoint.confidentialFlag);
  const refuse = (kind: OwnerSearchKind, reason: string | null): OwnerSearchPolicy => ({
    kind,
    field: null,
    reason,
    scopeWhere,
    confidential,
  });

  if (isReviewedUnservable(county, "owner_name")) {
    return refuse(
      "reviewed_unservable",
      reviewedCapability(county, "owner_name")?.basis?.note ??
        "this county publishes no usable owner name on its public endpoint",
    );
  }
  if (endpoint.attributeSearch === "unsupported") {
    return refuse("attribute_search_unsupported", ATTRIBUTE_SEARCH_UNSUPPORTED_REASON);
  }
  const named = endpoint.searchFields.filter(isOwnerNameColumn);
  const usable = named.find((sf) => sf.searchable !== false);
  if (usable) return { kind: "offered", field: usable.name, reason: null, scopeWhere, confidential };
  if (named.length > 0) return refuse("owner_unsearchable", OWNER_UNSEARCHABLE_REASON);
  return refuse("no_owner_column", null);
}

/**
 * An ArcGIS `where` is SQL, and a single quote closes the string literal.
 * encodeURIComponent does not help: `'` and `)` are both in its unreserved set, so
 * `A') OR 1=1 --` passes through encoding intact and lands OUTSIDE the quotes as a
 * live predicate against a county's server. Doubling the quote is the SQL-standard
 * escape and keeps the whole input inside the literal where it belongs.
 *
 * Every caller that puts user text in a `where` goes through this, including the
 * clause rendered for a human to copy: escaping only the URL would leave the same
 * payload one paste away from running.
 */
export function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * The raw SQL owner match, scoped when the layer is shared and with the
 * county's confidential owners excluded when the layer flags them. Both the
 * query URL (which encodes this string) and the clause printed for a human
 * come from here, so the two can never disagree about the scope, the exclusion
 * or the escaping. The scope is curated registry text, not user input, so it
 * is not escaped. A layer with no confidential flag gets exactly the clause it
 * got before the flag existed.
 */
export function ownerWhereClause(
  field: string,
  scopeWhere: string | null,
  ownerName: string,
  confidential: ConfidentialExclusion | null,
): string {
  const match = `UPPER(${field}) LIKE UPPER('%${escapeSqlLiteral(ownerName)}%')`;
  const scoped = scopeWhere ? `(${scopeWhere}) AND ${match}` : match;
  return confidential ? `(${scoped}) AND ${confidential.where}` : scoped;
}

/**
 * The list_counties coverage label, summarised across a county's endpoints.
 * What each label promises a caller deciding whether to spend a request:
 *   "owner+APN"            build_owner_query returns a URL for at least one endpoint.
 *   "APN only (county publishes no owner name)"
 *                          a reviewed record says owner names are not served.
 *   "location queries only"
 *                          no endpoint answers attribute searches; parcels are
 *                          reached by geometry, which also returns owner fields.
 *   "APN only (owner column not searchable)"
 *                          an owner column exists but the county marks it unsearchable.
 *   "APN only"             no endpoint documents an owner column.
 */
export function ownerCoverageLabel(
  county: CountyPolicyFields & { endpoints: readonly EndpointSearchPolicyFields[] },
): string {
  const kinds = county.endpoints.map((ep) => ownerSearchPolicy(county, ep).kind);
  if (kinds.includes("offered")) return "owner+APN";
  if (kinds.includes("reviewed_unservable")) return "APN only (county publishes no owner name)";
  if (kinds.length > 0 && kinds.every((k) => k === "attribute_search_unsupported")) {
    return "location queries only";
  }
  if (kinds.includes("owner_unsearchable")) return "APN only (owner column not searchable)";
  return "APN only";
}

/**
 * The ready-to-fire owner query URL for an endpoint, or "" when no owner column
 * is offered. `resultRecordCount=25` is added ONLY where the layer pages: a
 * layer flagged `supportsPagination: false` answers that parameter with HTTP 200
 * and a 400 error body instead of rows. The rule is the package's
 * `offersPagination`, read here, never re-derived.
 */
export function buildArcgisOwnerQuery(
  endpoint: Pick<EndpointRecord, "url" | "searchFields" | "supportsPagination">,
  owner: OwnerSearchPolicy,
  ownerQuery: string,
): string {
  if (!owner.field) return "";
  const where = encodeURIComponent(
    ownerWhereClause(owner.field, owner.scopeWhere, ownerQuery, owner.confidential),
  );
  const fields = endpoint.searchFields.filter((sf) => sf.searchable).map((sf) => sf.name);
  // The flag column comes back with the owner, as the atlas asks, so whoever
  // reads the rows can drop a flagged one as well.
  if (owner.confidential && !fields.includes(owner.confidential.field)) {
    fields.push(owner.confidential.field);
  }
  const liveFields = fields.join(",");
  return (
    `${endpoint.url}/query` +
    `?where=${where}` +
    `&outFields=${liveFields}` +
    `&returnGeometry=false` +
    `&f=json` +
    (offersPagination(endpoint) ? `&resultRecordCount=25` : "")
  );
}

/** The build_owner_query note on how many rows the query returns. */
export function ownerQueryRowsNote(
  endpoint: Pick<EndpointRecord, "supportsPagination" | "maxRecordCount">,
): string {
  if (offersPagination(endpoint)) return "Returns up to 25 records";
  const cap =
    typeof endpoint.maxRecordCount === "number"
      ? `at most ${endpoint.maxRecordCount} records`
      : "at most the layer's own record cap";
  return (
    `This layer does not paginate, so the query carries no resultRecordCount and returns ${cap}; ` +
    "exceededTransferLimit in the response says whether more matched, so narrow the where clause instead of paging"
  );
}
