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
 *   4. confidential_flag_incomplete: a searchable owner column exists, but the
 *      layer's `confidentialFlag` is present and malformed, so no exclusion can
 *      be built. A malformed flag is never read as "no flag": that would hand
 *      out the confidential owners the flag exists to keep out.
 *   5. offered: the first owner-name column that is searchable (the column
 *      test is the UKS classifier's; see OWNER_RE below).
 *   6. no_owner_column: the layer documents no owner column at all.
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
 * match, and buildArcgisOwnerQuery requests the column. A flag that is
 * present but malformed comes back as `{ kind: "incomplete" }`, never null.
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
  | "confidential_flag_incomplete"
  | "no_owner_column";

export interface OwnerSearchPolicy {
  kind: OwnerSearchKind;
  /** The owner column to query. Set only when kind is "offered". */
  field: string | null;
  /** Why no owner query is offered. Null when offered or when there is simply no owner column. */
  reason: string | null;
  /** SQL predicate scoping a shared layer to this county, or null. */
  scopeWhere: string | null;
  /**
   * The layer's confidential-owner flag: the exclusion when the flag is well
   * formed, `incomplete` when it is present but malformed. Null ONLY when the
   * endpoint carries no flag at all, so a truthy check means "flagged".
   */
  confidential: ConfidentialPolicy | null;
}

export interface ConfidentialExclusion {
  kind: "exclude";
  /** The flag column, requested with the owner so a reader can drop a flagged row too. */
  field: string;
  /** ANDed into every owner query. */
  where: string;
  /** The flag values, uppercased, for a reader that filters rows itself. */
  values: string[];
  /** The exact raw cells the layer holds for an unflagged owner; every other cell drops out. */
  safeValues: Array<string | number>;
}

export interface IncompleteConfidentialFlag {
  kind: "incomplete";
  /** The flag column when it is a usable identifier, else null. */
  field: string | null;
  /** What is wrong with the flag record. */
  problem: string;
}

export type ConfidentialPolicy = ConfidentialExclusion | IncompleteConfidentialFlag;

// A bare column identifier: the field is written into the SQL unquoted, so
// nothing else may pass. A dotted (joined-layer) name is refused too, which
// fails closed.
const FLAG_FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// A value is a SQL literal, printed in the answer, and uppercased on both sides
// of the comparison, so only ASCII letters and digits pass: JavaScript and the
// database agree on the uppercase of the VALUE, and none of them is a LIKE
// wildcard, a quote, whitespace or a control character. This constrains the
// value only, not the remote cell (see the UPPER note below). "\u00df" (which JavaScript uppercases
// to "SS") and the dotless "\u0131" make the flag incomplete.
const FLAG_VALUE_RE = /^[A-Za-z0-9]+$/;
// A safe value is compared whole, as a quoted SQL literal, so printable ASCII
// passes (padding included; a quote is doubled) except a backslash, which a
// backend that reads it as an escape would take as the end of the literal.
const SAFE_VALUE_RE = /^[\x20-\x5b\x5d-\x7e]*$/;

function flagProblem(flag: unknown): { field: string | null; problem: string | null } {
  if (typeof flag !== "object" || flag === null) {
    return { field: null, problem: "the flag record is not an object" };
  }
  const { field, values } = flag as { field?: unknown; values?: unknown };
  const goodField = typeof field === "string" && FLAG_FIELD_RE.test(field) ? field : null;
  if (!goodField) return { field: null, problem: "the flag names no usable column" };
  if (!Array.isArray(values) || values.length === 0) {
    return { field: goodField, problem: "the flag lists no values" };
  }
  // An index loop, on the RAW value: find(), some() and map() skip or
  // misreport a hole ([, "Y"]) or an undefined element, and a test on the
  // uppercased value would let "\u00df" through as "SS".
  for (let i = 0; i < values.length; i++) {
    const v: unknown = values[i];
    if (typeof v !== "string" || !FLAG_VALUE_RE.test(v)) {
      return { field: goodField, problem: "a flag value is not ASCII letters and digits only" };
    }
  }
  const safe: unknown = (flag as { safeValues?: unknown }).safeValues;
  if (!Array.isArray(safe) || safe.length === 0) {
    return { field: goodField, problem: "the flag lists no safe values" };
  }
  const markers = (values as string[]).map((v) => v.toUpperCase());
  const seen = new Set<string>();
  for (let i = 0; i < safe.length; i++) {
    const s: unknown = safe[i];
    if (!((typeof s === "string" && SAFE_VALUE_RE.test(s)) || (typeof s === "number" && Number.isSafeInteger(s)))) {
      return { field: goodField, problem: "a safe value is not printable ASCII text without a backslash, or an integer" };
    }
    if (markers.some((m) => String(s).trim().toUpperCase().includes(m))) {
      return { field: goodField, problem: "a safe value holds a flag value" };
    }
    const key = `${typeof s}:${String(s)}`;
    if (seen.has(key)) return { field: goodField, problem: "a safe value repeats" };
    seen.add(key);
  }
  return { field: goodField, problem: null };
}

/**
 * The exclusion for a layer's confidential-owner flag. Every value V is a
 * CONTAINS test, `NOT LIKE '%V%'`: Harris packs one Y/N per ownership slot,
 * "YNNNNNNNNN", which an equality test would keep. The atlas README makes a
 * value longer than one character an equality test after trimming; this
 * server makes it a contains test too, which DELIBERATELY EXCLUDES MORE than
 * the atlas's rule (" SEALED" and "UNSEALED" both drop out for "SEALED").
 * That is the fail-closed direction, and it needs no TRIM, which the three
 * layers refuse (below).
 *
 * FAIL CLOSED ON MALFORMED METADATA. Only an absent flag (undefined) means
 * "unflagged". A flag that is present but whose field is not a bare
 * identifier, whose values are missing or empty, whose values are not all
 * ASCII letters and digits, or that lists no usable safe values comes back
 * `incomplete`: ownerSearchPolicy then
 * offers no owner query, and get_parcel_endpoint withholds the atlas's sample
 * query.
 *
 * The cell is CAST to text first. Ector's conf_flg is a small integer, and its
 * server answers `conf_flg NOT LIKE '%1%'` (and `<> '1'`) with an ArcGIS error
 * (code 400, inside an HTTP 200 response), which would break every Ector owner
 * query; the cast form answers on all three
 * layers with the same counts as the bare form (measured 2026-10-25). The atlas
 * already reads the cell as text.
 *
 * The cast cell is UPPERed and so is each value, as the atlas compares after
 * uppercasing: `UPPER(CAST(f AS VARCHAR(255))) NOT LIKE '%Y%'`. A backend whose
 * LIKE is case-sensitive would otherwise keep a "y" cell.
 *
 * NON-ASCII CELLS. SQL UPPER matches JavaScript's toUpperCase on ASCII only. A
 * non-ASCII character can only make the atlas's rule flag a cell when its
 * JavaScript uppercase holds a letter of the value ("\u00df" reads as "SS",
 * a dotless "\u0131" as "I", "\u1e99" as "Y" plus a ring), and a backend
 * may leave it as it is. So every such character that shares a letter with a
 * value gets its own `CAST(f AS VARCHAR(255)) NOT LIKE '%c%'`, on the raw cell:
 * a cell holding one drops out. UPPER_TO_ASCII lists them all (17), and the
 * tests recompute it over every code point. What stays assumed of the backend:
 * UPPER maps ASCII a-z to A-Z (a Turkish-locale UPPER does not), LIKE reads the
 * whole cell (SQLite's stops at an embedded NUL), a flag cell fits the
 * 255-character cast, and the cell and the literals share one encoding.
 * Measured live on 2026-10-26, Harris and Collin answer those clauses with
 * unchanged counts and hold no such cell. Measured live on
 * 2026-10-25, Harris and Collin already compare case-insensitively, and the
 * UPPER form keeps the same rows as the bare form (Harris 1,541,671, Collin
 * 435,783); Ector answers the UPPER form with 77,042.
 *
 * The cell is NOT trimmed: TRIM(...) gets the same ArcGIS error on all three
 * layers. A contains test needs no trim, which is why every value uses it.
 *
 * SAFE VALUES CLOSE WHAT THE CLAUSES ABOVE ASSUME. The atlas lists the exact
 * raw cells a layer holds for an unflagged owner (Harris: blank and N runs,
 * each padded to 10 characters; Collin "F"; Ector 0), and the where ends with
 * `f IN (<those literals>)` on the raw column: a row stays only when the
 * backend itself says its cell equals one of them under its own comparison
 * rules. A NUL, a cut-off cell, a character a backend uppercases differently
 * or a new value nobody has reviewed all fail that, so the row drops out. A
 * PAD SPACE or case-insensitive backend also keeps a safe value padded or
 * cased differently, which holds no marker either. A flag with no safe values, or
 * a safe value that holds a marker, is incomplete: no owner query. Measured
 * live on 2026-10-26, the IN clause keeps exactly the rows the contains clauses
 * keep on all three layers.
 *
 * NULL is FLAGGED (fail-closed), as the atlas README requires of a row that
 * lacks the column: a NULL cell makes the comparison UNKNOWN, so the row
 * drops out. Harris has 5,235 NULL cells and Collin 15,003, and both fall
 * outside the clause live. Never COALESCE the cell to '' here: that would serve
 * them. This server stays fail-closed on a NULL cell.
 */
/**
 * Every code point outside ASCII whose JavaScript toUpperCase holds an ASCII
 * letter or digit: Unicode's special casings (sharp s, the ligatures, the
 * letters with a combining mark) plus the dotless i and the long s.
 */
export const UPPER_TO_ASCII: readonly string[] = [
  "\u00df", "\u0131", "\u0149", "\u017f", "\u01f0", "\u1e96", "\u1e97", "\u1e98", "\u1e99",
  "\u1e9a", "\ufb00", "\ufb01", "\ufb02", "\ufb03", "\ufb04", "\ufb05", "\ufb06",
];

export function confidentialExclusion(flag: ConfidentialFlag | undefined): ConfidentialPolicy | null {
  if (flag === undefined) return null;
  const { field, problem } = flagProblem(flag);
  if (problem !== null || field === null) {
    return { kind: "incomplete", field, problem: problem ?? "the flag names no usable column" };
  }
  const raw = `CAST(${field} AS VARCHAR(255))`;
  const values = flag.values.map((v) => v.toUpperCase());
  const safeValues = [...(flag as { safeValues: Array<string | number> }).safeValues];
  const expanders = UPPER_TO_ASCII.filter((ch) => [...ch.toUpperCase()].some((u) => values.some((v) => v.includes(u))));
  const where = [
    ...values.map((v) => `UPPER(${raw}) NOT LIKE '%${escapeSqlLiteral(v)}%'`),
    ...expanders.map((ch) => `${raw} NOT LIKE '%${ch}%'`),
    `${field} IN (${safeValues.map(sqlLiteral).join(", ")})`,
  ].join(" AND ");
  return { kind: "exclude", field, where, values, safeValues };
}

/**
 * What a read that goes around the owner query (by location or parcel id)
 * must do on a flagged layer: bring the flag column back and keep only the rows
 * the exclusion would keep. A location query on a layer that takes no where
 * clause cannot AND the exclusion in, so the reader filters the rows itself.
 */
function flaggedRowRule(c: ConfidentialExclusion): string {
  return `request ${c.field} in outFields and keep a row only when its ${c.field} cell is exactly one of ${JSON.stringify(c.safeValues)} and contains no ${c.values.join(" or ")} in any letter case; drop every other row, a missing or NULL cell included, and never show or pass on such a row`;
}

/** A safe value as a SQL literal: an integer bare, text quoted with its quotes doubled. */
function sqlLiteral(v: string | number): string {
  return typeof v === "number" ? String(v) : `'${escapeSqlLiteral(v)}'`;
}

/** An incomplete flag can keep no flagged owner out of any read, so none is advised. */
const INCOMPLETE_FLAG_NO_READ =
  "The layer's confidential-owner flag is incomplete, so no read can keep flagged owners out: do not read owner fields on this layer";

/** The reason build_owner_query and the Owner line give for a malformed flag. */
export function incompleteFlagReason(flag: IncompleteConfidentialFlag): string {
  return `the layer flags confidential owners${flag.field ? ` in ${flag.field}` : ""}, but its flag record is incomplete (${flag.problem}), so no owner query could keep them out`;
}

/**
 * The Confidential flag line find_county, get_parcel_endpoint and
 * build_owner_query print, so a caller ANDs the exclusion into any query of
 * their own, as with the scope. A malformed flag is reported as present but
 * incomplete, never left out. A layer with no attribute search takes no
 * where clause, so there the line gives the row rule instead of "AND this in".
 */
export function confidentialLine(owner: Pick<OwnerSearchPolicy, "confidential" | "kind">): string | null {
  const c = owner.confidential;
  if (!c) return null;
  if (c.kind === "incomplete") {
    return `Confidential flag: present but incomplete (${c.problem}): no exclusion can be built, so no owner query is offered on this layer; do not read owner fields here`;
  }
  if (owner.kind === "attribute_search_unsupported") {
    return `Confidential flag: ${c.where} (the county flags confidential owners in ${c.field}; this layer takes no where clause, so ${flaggedRowRule(c)})`;
  }
  return `Confidential flag: ${c.where} (the county flags confidential owners in ${c.field}; AND this into every query, and never show or pass on a flagged row)`;
}

// THE OWNER-COLUMN TEST, copied VERBATIM from the UrbanKit Studio canonical
// owner classifier (OWNER_RE and OWNER_EXCLUDE), which applies them to
// `${name} ${label}`. The two copies must stay byte-equal until
// @urbankitstudio/atlas exports the classifier (a queued follow-up); then
// import it and delete these lines.
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
  if (usable && confidential?.kind === "incomplete") {
    return refuse("confidential_flag_incomplete", incompleteFlagReason(confidential));
  }
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
 * got before the flag existed. An incomplete flag throws: there is no clause
 * that keeps its owners out, so none is built.
 */
export function ownerWhereClause(
  field: string,
  scopeWhere: string | null,
  ownerName: string,
  confidential: ConfidentialPolicy | null,
): string {
  if (confidential?.kind === "incomplete") {
    throw new Error(`no owner query on a layer whose confidential flag is incomplete (${confidential.problem})`);
  }
  const match = `UPPER(${field}) LIKE UPPER('%${escapeSqlLiteral(ownerName)}%')`;
  const scoped = scopeWhere ? `(${scopeWhere}) AND ${match}` : match;
  return confidential ? `(${scoped}) AND ${confidential.where}` : scoped;
}

/**
 * The list_counties coverage label, summarised across a county's endpoints.
 * What each label promises a caller deciding whether to spend a request:
 *   "owner+APN"            build_owner_query returns a URL for at least one endpoint.
 *   "APN only (county publishes no owner name)"
 *                          a reviewed record says the county serves no owner name
 *                          (status not_published).
 *   "APN only (owner name withheld)"
 *                          a reviewed record says the county does publish owner
 *                          names and they are withheld, by the county's terms or
 *                          while the county is asked (status restricted).
 *   "location queries only"
 *                          no endpoint answers attribute searches; parcels are
 *                          reached by geometry, which also returns owner fields.
 *   "APN only (owner column not searchable)"
 *                          an owner column exists but the county marks it unsearchable.
 *   "APN only (confidential flag incomplete)"
 *                          an owner column exists but the layer's confidential flag
 *                          is malformed, so no owner query is offered.
 *   "APN only"             no endpoint documents an owner column.
 */
export function ownerCoverageLabel(
  county: CountyPolicyFields & { endpoints: readonly EndpointSearchPolicyFields[] },
): string {
  const kinds = county.endpoints.map((ep) => ownerSearchPolicy(county, ep).kind);
  if (kinds.includes("offered")) return "owner+APN";
  if (kinds.includes("reviewed_unservable")) {
    return reviewedCapability(county, "owner_name")?.status === "restricted"
      ? "APN only (owner name withheld)"
      : "APN only (county publishes no owner name)";
  }
  if (kinds.length > 0 && kinds.every((k) => k === "attribute_search_unsupported")) {
    return "location queries only";
  }
  if (kinds.includes("owner_unsearchable")) return "APN only (owner column not searchable)";
  if (kinds.includes("confidential_flag_incomplete")) return "APN only (confidential flag incomplete)";
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
  if (owner.confidential?.kind === "exclude" && !fields.includes(owner.confidential.field)) {
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

/**
 * The Owner/Attribute line shared by find_county and get_parcel_endpoint. On
 * a flagged layer the read it points to carries the flag rule, or, for an
 * incomplete flag, gives way to "do not read owner fields here".
 */
export function ownerLine(owner: OwnerSearchPolicy): string {
  if (owner.field) return `Owner field: ${owner.field}`;
  const c = owner.confidential;
  if (owner.kind === "attribute_search_unsupported") {
    const base = `Attribute search: not offered (location queries only) - ${owner.reason}`;
    if (!c) return base;
    return c.kind === "incomplete"
      ? `${base}; the confidential flag is incomplete, so do not read owner fields here`
      : `${base}; a location query takes no where clause, so ${flaggedRowRule(c)}`;
  }
  if (owner.kind === "owner_unsearchable") {
    if (!c) return "Owner field: not searchable by name (column exists; use a parcel-id or location query)";
    return c.kind === "incomplete"
      ? "Owner field: not searchable by name (column exists, but the confidential flag is incomplete, so do not read owner fields here)"
      : `Owner field: not searchable by name (column exists; use a parcel-id or location query, AND the Confidential flag clause into its where, and ${flaggedRowRule(c)})`;
  }
  if (owner.kind === "confidential_flag_incomplete") {
    return `Owner field: not offered - ${owner.reason}`;
  }
  return owner.reason
    ? `Owner field: NOT AVAILABLE - ${owner.reason}`
    : "Owner field: NONE - this layer publishes no owner column";
}

/**
 * The build_owner_query refusal for an endpoint that offers no owner query.
 * Every refusal that points the caller at another read (by location, by parcel
 * id or address) also carries the Confidential flag line. On a flagged layer
 * the advice itself changes too: a well-formed flag adds the rule that read
 * must follow, and an incomplete one replaces the read with "do not read
 * owner fields on this layer".
 */
export function ownerRefusal(owner: OwnerSearchPolicy, place: string): string {
  let refusal: string;
  const c = owner.confidential;
  switch (owner.kind) {
    case "attribute_search_unsupported": {
      const advice = !c
        ? "Query the layer by location (a point or envelope geometry) to read the owner fields of the parcels there."
        : c.kind === "incomplete"
          ? `${INCOMPLETE_FLAG_NO_READ}, by location or otherwise.`
          : `To read owner fields, query the layer by location (a point or envelope geometry). It takes no where clause, so the exclusion below cannot be ANDed in: ${flaggedRowRule(c)}.`;
      refusal = `OWNER SEARCH NOT OFFERED on this layer for ${place}: ${owner.reason}\nNo where-clause query is possible here. ${advice}`;
      break;
    }
    case "owner_unsearchable": {
      // The owner IS published; only a name search on it is unsupported.
      const advice = !c
        ? "Use a parcel-id or location query instead; either returns the owner of the matching parcel."
        : c.kind === "incomplete"
          ? `${INCOMPLETE_FLAG_NO_READ}, by parcel id, location or otherwise.`
          : `Use a parcel-id or location query instead; either returns the owner of the matching parcel. AND the exclusion below into its where, and ${flaggedRowRule(c)}.`;
      refusal = `OWNER COLUMN NOT SEARCHABLE BY NAME for ${place}: ${owner.reason}\n${advice}`;
      break;
    }
    case "reviewed_unservable":
      refusal = `OWNER NAME NOT AVAILABLE for ${place}: ${owner.reason}\nNo owner query is possible here. Search by parcel number or address instead, or pick a county whose coverage reads owner+APN in list_counties.`;
      break;
    case "confidential_flag_incomplete":
      refusal = `OWNER SEARCH REFUSED for ${place}: ${owner.reason}.\nNo owner query is offered on this layer until its flag record is fixed.`;
      break;
    default:
      refusal = "Note: this layer publishes no owner or taxpayer column - PIN-only lookup. Try searching by parcel number instead.";
  }
  const confidential = confidentialLine(owner);
  return confidential ? `${refusal}\n${confidential}` : refusal;
}

/**
 * The two sample queries get_parcel_endpoint prints. On a flagged layer the
 * atlas's own sample is withheld, well formed flag or not, so the one sample
 * shown is built with this server's clauses (UPPER, the non-ASCII clauses and
 * the safe values), which are stricter than the atlas's. The sample owner query
 * is built with the exclusion, and only where an owner query is offered.
 */
export function parcelEndpointSamples(
  endpoint: Pick<EndpointRecord, "url" | "searchFields" | "supportsPagination" | "sampleQuery">,
  owner: OwnerSearchPolicy,
): { atlas: string | null; owner: string | null } {
  return {
    atlas: endpoint.sampleQuery && owner.confidential === null ? endpoint.sampleQuery : null,
    owner: owner.field ? buildArcgisOwnerQuery(endpoint, owner, "SMITH") : null,
  };
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
