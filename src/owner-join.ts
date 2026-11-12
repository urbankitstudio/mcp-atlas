/**
 * The owner join: owner rows a county keeps in a separate TABLE of its parcel
 * service (atlas 0.9.0 `ownerJoin`).
 *
 * Sussex County DE is the first: its parcel polygons are keyed on `Name` (the
 * PIN) and its owners sit in table 1 of the same service, keyed on `PIN`, one
 * or more rows per parcel. On such a record the layer's own searchFields carry
 * no owner column, so a reader that knows nothing of the join sees a
 * parcel-number-only layer. That is the safe default, and it is what this
 * server answered before 0.4.0.
 *
 * An owner-name search on such a record goes to the TABLE, as an attribute
 * query and nothing else: a `where` on the table's owner column, never a
 * geometry parameter. A table has no geometry and ignores one, answering with
 * arbitrary rows.
 *
 * This file holds the same rules as UrbanKit Studio's own join engine and as
 * rule J8 of the registry validator: when a join may be used at all
 * (usableOwnerJoin), which columns one table request asks for
 * (ownerJoinOutFields), and how its rows are read (readOwnerJoinRows). The
 * site's engine asks the table by key and checks that every row echoes a key
 * it asked; an owner-name search asks by owner, so the echo it checks is the
 * owner predicate.
 *
 * THIS SERVER BUILDS THE URL AND NEVER FETCHES IT, so no tool here sees a row.
 * The reading rules reach a caller two ways, and both come from this file:
 * ownerJoinNotes is the text build_owner_query prints under the URL, and
 * readOwnerJoinRows is the same rules in code, shipped in dist/owner-join.js
 * for a caller that reads the rows with this package. No fetch, no clock.
 */

import { offersAttributeSearch, offersPagination, reviewedCapability } from "@urbankitstudio/atlas";
import type { CountyRecord, EndpointRecord, OwnerJoin } from "@urbankitstudio/atlas";

/** The endpoint fields that decide whether its join may be used. */
export type OwnerJoinEndpointFields = Pick<
  EndpointRecord,
  | "searchFields"
  | "ownerJoin"
  | "scopeWhere"
  | "sharedService"
  | "confidentialFlag"
  | "supportsPagination"
  | "attributeSearch"
>;

type CountyJoinFields = Pick<CountyRecord, "capabilityOverrides">;

/** One table row: the `attributes` of a returned feature, cut to the columns asked for. */
export type OwnerJoinRow = Record<string, unknown>;

/**
 * Is anything beside the join that the join path does not handle? The
 * registry validator refuses each of these on a record with an ownerJoin
 * "until that combination is built" (its rule J8), so no published record is
 * expected to reach a true here. This is the same refusal at run time, for a
 * record that got past the validator:
 *   - the county withholds owner or mailing columns (a reviewed `restricted`
 *     record): withheld columns are marked on searchFields, and nothing marks
 *     the table's;
 *   - scopeWhere or sharedService: the service holds other counties' rows, and
 *     the scope is a predicate on the layer, not on the table;
 *   - confidentialFlag: the flag is on the polygon row, the owner on the table
 *     row, so no exclusion could be ANDed into the table query. Any flag that
 *     is present counts, well formed or not;
 *   - supportsPagination: false: the table is read in pages;
 *   - attributeSearch "unsupported": the table is asked by `where` and nothing
 *     else;
 *   - any wireName, on either field list: the join path sends bare names.
 */
function joinCompanionRefused(county: CountyJoinFields, endpoint: OwnerJoinEndpointFields, join: OwnerJoin): boolean {
  return (
    reviewedCapability(county, "owner_name")?.status === "restricted" ||
    reviewedCapability(county, "owner_mailing_address")?.status === "restricted" ||
    endpoint.scopeWhere !== undefined ||
    endpoint.sharedService === true ||
    endpoint.confidentialFlag !== undefined ||
    !offersPagination(endpoint) ||
    !offersAttributeSearch(endpoint) ||
    [...endpoint.searchFields, ...join.fields].some((f) => f.wireName !== undefined)
  );
}

/** Whether the join record has the parts a table query is built from. */
function joinReadable(join: OwnerJoin): boolean {
  const text = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
  return (
    text(join.url) &&
    text(join.key) &&
    text(join.parcelKey) &&
    text(join.orderField) &&
    Array.isArray(join.fields) &&
    join.fields.every((f) => typeof f === "object" && f !== null && text(f.name)) &&
    join.fields.some((f) => f.name === join.key)
  );
}

/**
 * The join an owner query may use on this endpoint, or null. Null means the
 * record is served as the plain layer its searchFields describe, and the table
 * is never named or asked.
 */
export function usableOwnerJoin(county: CountyJoinFields, endpoint: OwnerJoinEndpointFields): OwnerJoin | null {
  const join = endpoint.ownerJoin;
  if (typeof join !== "object" || join === null || !joinReadable(join)) return null;
  // ANCHOR owner-join-companions
  return joinCompanionRefused(county, endpoint, join) ? null : join;
}

/** The table's layer URL without a trailing slash, ready for `/query`. */
export function ownerJoinTableUrl(join: OwnerJoin): string {
  return join.url.replace(/\/+$/, "");
}

/**
 * The table columns that carry what a row serves: every documented searchable
 * column except the key, the row label and the order column, the same
 * searchable-only rule build_owner_query applies to a parcel layer. On Sussex DE
 * that is the owner name alone: the record marks its mailing columns
 * `searchable: false`, so they are never requested. The row label (`rowIdField`) is left
 * out on purpose: it is not unique, and two rows that differ only by it are
 * one ownership record.
 */
function ownerJoinContentFields(join: OwnerJoin): string[] {
  const skipped = new Set([join.key, join.rowIdField, join.orderField]);
  // Bare names: usableOwnerJoin refuses a join beside any wireName.
  return join.fields.filter((f) => f.searchable && !skipped.has(f.name)).map((f) => f.name);
}

/**
 * The columns one owner-name query asks the table for: the parcel key first,
 * then the content columns, and the searched owner column whatever its flags.
 */
export function ownerJoinOutFields(join: OwnerJoin, ownerField: string): string[] {
  const fields = [join.key, ...ownerJoinContentFields(join)];
  if (!fields.includes(ownerField)) fields.push(ownerField);
  return fields;
}

/** The most different rows one key may hold and still be read as its owners.
 *  Without `multiple: "rows"`, or with a ceiling that is not a positive
 *  integer, it is 1: picking one of several owners would be a guess. */
export function ownerJoinRowCap(join: OwnerJoin): number {
  const cap = join.maxRowsPerKey;
  return join.multiple === "rows" && typeof cap === "number" && Number.isInteger(cap) && cap >= 1 ? cap : 1;
}

/** Text as the owner comparison reads it: compatibility forms and accents
 *  folded away, then upper-cased. A county database decides for itself what
 *  LIKE matches, and one that ignores accents honestly returns an accented
 *  name for a plain search, so such a row is not a stray one. */
function foldName(text: string): string[] {
  return [...text.normalize("NFKD").replace(/\p{M}/gu, "").toUpperCase()];
}

/** SQL LIKE over code points: `%` is any run, `_` is any one character. */
function likeMatches(text: readonly string[], pattern: readonly string[]): boolean {
  let t = 0;
  let p = 0;
  let run = -1;
  let resume = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === "%") {
      run = p++;
      resume = t;
    } else if (p < pattern.length && (pattern[p] === "_" || pattern[p] === text[t])) {
      p++;
      t++;
    } else if (run !== -1) {
      p = run + 1;
      t = ++resume;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "%") p++;
  return p === pattern.length;
}

/**
 * Does this owner cell satisfy the predicate the query sent,
 * `UPPER(col) LIKE UPPER('%<name>%')`? A `%` or `_` inside the name is a LIKE
 * wildcard on the county's server (the where clause escapes quotes only), so
 * it is one here. A cell that is not text never matches: SQL keeps no row
 * whose owner is NULL under that predicate.
 */
export function ownerCellMatches(cell: unknown, ownerQuery: string): boolean {
  if (typeof cell !== "string") return false;
  return likeMatches(foldName(cell), ["%", ...foldName(ownerQuery), "%"]);
}

/**
 * Did the table answer the question that was asked? True only when EVERY
 * returned row holds the searched name in the owner column. A table that
 * ignores `where` returns its first rows whatever was asked; one stray row
 * fails the whole response, because a server that ignored the clause once
 * cannot be trusted on the rows that happen to match.
 */
export function verifyOwnerEcho(rows: readonly OwnerJoinRow[], ownerField: string, ownerQuery: string): boolean {
  // ANCHOR owner-join-echo
  return rows.every((row) => ownerCellMatches(row[ownerField], ownerQuery));
}

/** A key as both sides compare it: trimmed, nothing else. Null for a value
 *  that is neither text nor a safe integer (JSON.parse has already rounded an
 *  integer past 2^53, so its digits can be another parcel's), and for a visibly
 *  blank one: a key of only zero-width, control or filler characters is blank,
 *  as the UrbanKit Studio engine's normalizeJoinKey reads it. */
function joinKeyOf(value: unknown): string | null {
  if (typeof value !== "string" && !(typeof value === "number" && Number.isSafeInteger(value))) return null;
  const key = String(value).trim();
  // ANCHOR owner-join-key-blank
  return visibleText(key) === "" ? null : key;
}

/** One returned feature cut to the columns that were asked for. Anything else
 *  the server sent is dropped here; a feature with no `attributes` object is an
 *  empty row, which fails the echo check. */
function projectFeature(feature: unknown, fields: readonly string[]): OwnerJoinRow {
  const out: OwnerJoinRow = {};
  const attributes = typeof feature === "object" && feature !== null ? (feature as { attributes?: unknown }).attributes : null;
  if (typeof attributes !== "object" || attributes === null) return out;
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(attributes, field)) out[field] = (attributes as OwnerJoinRow)[field];
  }
  return out;
}

/** Control characters (C0 and C1), NUL included. */
const CONTROL_RE = /\p{Cc}/gu;
/** Format characters: zero-width space and joiners, word joiner, BOM, soft hyphen. */
const FORMAT_RE = /\p{Cf}/gu;
/** Combining marks of every kind (Mn, Mc, Me). */
const MARK_RE = /\p{M}/gu;
/** Variation selectors, Mongolian free variation selectors, Khmer U+17B4 and U+17B5, the Hangul fillers. */
const IGNORABLE_RE = /\p{Default_Ignorable_Code_Point}/gu;
/** The six fillers that render blank: the braille blank, the four Hangul fillers and the musical null notehead. */
const BLANK_FILLER_RE = /[\u2800\u3164\u115f\u1160\uffa0\u{1d159}]/gu;

/** The text with every character that renders as nothing removed and each run of
 *  whitespace made one space, trimmed. This is UrbanKit Studio's `visibleText`
 *  (src/lib/blank-cell.ts), character for character. */
function visibleText(text: string): string {
  return text
    .replace(/\s+/gu, " ")
    .replace(CONTROL_RE, "")
    .replace(FORMAT_RE, "")
    .replace(MARK_RE, "")
    .replace(IGNORABLE_RE, "")
    .replace(BLANK_FILLER_RE, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/** One content cell as the de-duplication compares it: NFKC-normalised, only
 *  the visible text, upper-cased. Null for a missing, null or visibly blank cell,
 *  which serves nothing. Accents stay: "PEÑA" and "PENA" are two values (the
 *  owner echo folds them, this does not). */
function comparedCell(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  // ANCHOR owner-join-nfkc
  const text = visibleText(String(value).normalize("NFKC")).toUpperCase();
  return text === "" ? null : text;
}

/** Does `wide` carry every value `narrow` carries? A null cell of `narrow` carries nothing. */
function subsumes(wide: ReadonlyArray<string | null>, narrow: ReadonlyArray<string | null>): boolean {
  return narrow.every((cell, i) => cell === null || cell === wide[i]);
}

/**
 * The rows of one key, one per distinct served content, first occurrence kept;
 * then a row that says nothing another kept row does not is dropped. This is the
 * rule of UrbanKit Studio's join engine (dedupeJoinRows in its
 * radius-join-core.ts), applied to the content columns.
 *
 * Cells compare as `visibleText(String(cell).normalize("NFKC")).toUpperCase()`:
 * each run of whitespace is one space and the characters that render as nothing
 * (controls, format characters such as a zero-width space, combining marks,
 * default-ignorable code points, the blank fillers) are removed. So "SMITH JOHN",
 * the same with two inner spaces and the same with a trailing zero-width space
 * are one row, and so are one name's precomposed and decomposed accents, while
 * "PEÑA" and "PENA" stay two. A null, missing or visibly blank cell is null and
 * serves nothing. Only the comparison folds; the row kept is returned as the
 * county wrote it.
 *
 * A kept row is then dropped when another kept row subsumes it: every non-null
 * cell of the narrow row equals that cell of the wide one. That covers
 *   - a row with no served value at all, when the key has another row (a key
 *     whose ONLY row is empty keeps it);
 *   - one owner once with and once without a mailing line, in either order.
 * A row that carries a value no other row does stays: two named owners sharing
 * a mailing address are two rows, and so is one owner at two mailing addresses.
 * Kept rows are distinct, so two rows never subsume each other and the filter
 * cannot drop every row of a key. The row ceiling counts what is left.
 *
 * Two differences from the UrbanKit Studio engine. It reads cells through the
 * endpoint's roles (owner, site address, mailing) and treats a placeholder owner
 * ("UNKNOWN", "N/A") as no owner, while this compares the raw content columns;
 * every row here has passed the owner echo, so a placeholder owner can only
 * appear when the search is for the placeholder itself. And it tests a cell for
 * blankness before NFKC, so a cell that NFKC turns into nothing visible (a lone
 * spacing accent such as U+00B4 becomes a space and a combining mark) is an empty
 * value there and null here. Keys follow the engine's blank rule exactly.
 */
function dedupeByContent(rows: readonly OwnerJoinRow[], content: readonly string[]): OwnerJoinRow[] {
  const seen = new Set<string>();
  const kept: Array<{ row: OwnerJoinRow; cells: Array<string | null> }> = [];
  for (const row of rows) {
    const cells = content.map((field) => comparedCell(row[field]));
    const signature = JSON.stringify(cells);
    if (seen.has(signature)) continue;
    seen.add(signature);
    kept.push({ row, cells });
  }
  // ANCHOR owner-join-subsumed
  return kept.filter((k) => !kept.some((o) => o !== k && subsumes(o.cells, k.cells))).map((k) => k.row);
}

/**
 * What the table said about one parcel key.
 *   joined     its matching ownership rows, de-duplicated, within the row cap
 *   ambiguous  more different rows than the record allows: none is served
 */
export type OwnerJoinKeyRows = { state: "joined"; rows: OwnerJoinRow[] } | { state: "ambiguous"; count: number };

export type OwnerJoinRead =
  | {
      ok: true;
      /** Parcel key to its rows, in first-seen order. */
      byKey: Map<string, OwnerJoinKeyRows>;
      /** Rows that matched but carry no usable key: tied to no parcel, so not served. */
      unkeyed: number;
    }
  | { ok: false; reason: "join-integrity" };

/**
 * Read the features of an owner-name query against the table.
 *
 * `features` is the response's `features` array, every page read so far.
 * `ownerField` and `ownerQuery` are the column and the name the query was
 * built with. The whole result is refused as `join-integrity` when any row
 * fails the owner echo; otherwise each key's rows are de-duplicated by content
 * and held to the record's row cap.
 *
 * A key's rows here are the ones that matched the name. The parcel may hold
 * other owners, which a name search does not return.
 */
export function readOwnerJoinRows(
  join: OwnerJoin,
  ownerField: string,
  ownerQuery: string,
  features: readonly unknown[],
): OwnerJoinRead {
  const fields = ownerJoinOutFields(join, ownerField);
  const rows = features.map((feature) => projectFeature(feature, fields));
  if (!verifyOwnerEcho(rows, ownerField, ownerQuery)) return { ok: false, reason: "join-integrity" };

  const grouped = new Map<string, OwnerJoinRow[]>();
  let unkeyed = 0;
  for (const row of rows) {
    const key = joinKeyOf(row[join.key]);
    if (key === null) {
      unkeyed++;
      continue;
    }
    const own = grouped.get(key);
    if (own) own.push(row);
    else grouped.set(key, [row]);
  }

  const content = fields.filter((field) => field !== join.key);
  const cap = ownerJoinRowCap(join);
  const byKey = new Map<string, OwnerJoinKeyRows>();
  for (const [key, own] of grouped) {
    const distinct = dedupeByContent(own, content);
    // ANCHOR owner-join-row-cap
    byKey.set(key, distinct.length > cap ? { state: "ambiguous", count: distinct.length } : { state: "joined", rows: distinct });
  }
  return { ok: true, byKey, unkeyed };
}

/**
 * The notes build_owner_query prints under a table query: what the rows are,
 * and the reading rules of readOwnerJoinRows in words, since the caller
 * fetches the URL and this server never sees a row.
 */
export function ownerJoinNotes(join: OwnerJoin, ownerField: string, layerUrl: string): string[] {
  const cap = ownerJoinRowCap(join);
  return [
    `The rows come from the county's owner table, not the parcel layer: each is one ownership record with no geometry, and its ${join.key} is the parcel's ${join.parcelKey} on the parcel layer ${layerUrl}`,
    `Check every row before using any: each must hold the searched name in ${ownerField}. If one does not, the table did not apply the where clause, so discard the whole response and show none of its owners`,
    `One ${join.key} can hold several rows: de-duplicate them by the values you read, compared without regard to letter case, invisible characters or runs of whitespace (never by a row label, which is not unique), and drop a row whose values another row of the ${join.key} already carries (the same owner once with and once without a mailing line is one record). ` +
      (cap === 1
        ? `A ${join.key} left with more than one different row has no single owner: show none of its rows`
        : `A ${join.key} left with more than ${cap} different rows has no owner you can state: show none of its rows`),
    `A row whose ${join.key} is blank, or holds only invisible characters, belongs to no parcel: show none of it`,
    `For more rows add &resultOffset=25 (then 50, and so on) and keep orderByFields=${join.orderField}, which holds the pages in one order`,
  ];
}
