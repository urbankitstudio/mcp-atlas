/**
 * get_city_datasets: the code-violation, building-permit and zoning-case
 * datasets UrbanKit has verified for a city, and how to query them by street.
 *
 * Pure and synchronous, and importable without starting the stdio transport, so
 * test/city-datasets.test.mjs drives it directly (search-policy.ts is the same
 * shape). It reads ONLY @urbankitstudio/atlas exports (listCities, findCity,
 * getCityProperty, getCityZoning, cityDatasets, streetForDataset,
 * buildCityQuery, cityPath, slugify) and never fetches: the registry ships
 * inside the package, so there is no "registry temporarily unavailable" case
 * here, and every URL it returns is a string for the caller to run.
 *
 * It mirrors the hosted MCP tool of the same name (urbankitstudio api/mcp.ts,
 * case "get_city_datasets"): same input caps, same enum, same street handling
 * (cut at the first comma, then trim), and the same snake_case wire keys for the
 * list, found, ambiguous and not-found answers. The deliberate differences:
 *   - the hosted metering sentence is gone (this server has no tiers or keys),
 *   - the not-found message points at find_county, the stdio tool, instead of
 *     the hosted find_parcel_by_address.
 */

import {
  CITY_STREET_MAX_LEN,
  buildCityQuery,
  cityPath,
  getCityProperty,
  getCityZoning,
  listCities,
  findCity,
  cityDatasets,
  slugify,
  streetForDataset,
} from "@urbankitstudio/atlas";
import type { CityKind, CitySummary } from "@urbankitstudio/atlas";

export const CITY_REF_MAX_LEN = 80;
export const CITY_STATE_MAX_LEN = 40;
export { CITY_STREET_MAX_LEN };
export const CITY_KINDS: readonly CityKind[] = ["violations", "permits", "zoning"];

export const CITY_BASE_URL = "https://urbankitstudio.com";

/**
 * Appended to a dataset's query_note only when streetForDataset (the package's
 * split-address rule) changed the typed street: the table keeps the house number
 * in its own column with no streetNumber mapping, so the name alone is matched.
 * Same wording as the hosted tool.
 */
export const SPLIT_ADDRESS_UNMAPPED_NOTE =
  "This dataset stores the house number in a separate column that is not yet mapped; the query matches the street name only.";

export interface CityDatasetsArgs {
  city?: string | null;
  state?: string | null;
  kind?: string | null;
  street?: string | null;
}

export interface CityDatasetsResult {
  isError: boolean;
  /** An error message, or the answer as indented JSON (the hosted tool's encoding). */
  text: string;
}

const ok = (answer: unknown): CityDatasetsResult => ({
  isError: false,
  text: JSON.stringify(answer, null, 2),
});
const fail = (message: string): CityDatasetsResult => ({ isError: true, text: message });

/** encodeURIComponent throws on a lone surrogate, which valid JSON can carry. */
function isWellFormedText(s: string): boolean {
  try {
    encodeURIComponent(s);
    return true;
  } catch {
    return false;
  }
}

function citySummaryOut(c: CitySummary) {
  return {
    slug: c.slug,
    city: c.city,
    state_abbrev: c.stateAbbrev,
    county_slug: c.countySlug ?? null,
    kinds: c.kinds,
  };
}

/** camelCase -> snake_case on one level of keys. */
function snakeKeys(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(o).map(([k, v]) => [k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`), v]),
  );
}

const sourceOut = (s: {
  name: string;
  url: string;
  license?: string;
  portalLabel?: string;
  currentRecordsNote?: string;
}) => ({
  name: s.name,
  url: s.url,
  license: s.license ?? null,
  portal_label: s.portalLabel ?? null,
  current_records_note: s.currentRecordsNote ?? null,
});

/**
 * `resolve` is a test seam only: the registry carries no ambiguous city name
 * today (Columbus is one city), so the ambiguous branch is exercised by handing
 * in a finder over a fixture list. The server never passes it.
 */
export function getCityDatasets(
  args: CityDatasetsArgs,
  resolve: (ref: string, state?: string) => CitySummary[] = findCity,
): CityDatasetsResult {
  const cityRef = String(args.city ?? "").trim();
  const stateRef = String(args.state ?? "").trim();
  const kindRaw =
    args.kind === undefined || args.kind === null ? "" : String(args.kind).trim().toLowerCase();
  const streetRaw = String(args.street ?? "").trim();

  if (cityRef.length > CITY_REF_MAX_LEN) return fail(`city must be at most ${CITY_REF_MAX_LEN} characters`);
  if (stateRef.length > CITY_STATE_MAX_LEN) return fail(`state must be at most ${CITY_STATE_MAX_LEN} characters`);
  if (streetRaw.length > CITY_STREET_MAX_LEN) return fail(`street must be at most ${CITY_STREET_MAX_LEN} characters`);
  for (const [name, value] of [["city", cityRef], ["state", stateRef], ["street", streetRaw]] as const) {
    if (!isWellFormedText(value)) return fail(`${name} must be well-formed text (no unpaired surrogate)`);
  }
  if (kindRaw && !CITY_KINDS.includes(kindRaw as CityKind)) {
    return fail("kind must be 'violations', 'permits' or 'zoning'");
  }
  const kind = (kindRaw || undefined) as CityKind | undefined;
  // The street line only: "600 Commerce St, Dallas, TX" is cut at the comma,
  // because the city is the city argument and the substring match would
  // otherwise look for the literal ", Dallas, TX" inside the address column.
  const street = streetRaw.split(",")[0].trim();

  if (!cityRef) {
    const list = listCities({ state: stateRef || undefined, kind });
    return ok({
      total_cities: list.length,
      cities: list.map(citySummaryOut),
      note:
        "kinds are the dataset kinds UrbanKit has verified for the city: 'violations' and 'permits' are the city's own code-enforcement and permit tables, 'zoning' its rezoning docket or current zoning map. Call again with city (and optionally kind and street) for the endpoint and a ready query URL. Scope is the city's limits, not the county; parcel owners are the county tools.",
    });
  }

  const matches = resolve(cityRef, stateRef || undefined);

  if (matches.length === 0) {
    const covered = listCities();
    const comma = cityRef.indexOf(",");
    const stateHint = stateRef || (comma >= 0 ? cityRef.slice(comma + 1).trim() : "");
    const refSlug = slugify(comma >= 0 ? cityRef.slice(0, comma) : cityRef);
    const inState = stateHint ? listCities({ state: stateHint }) : [];
    // A county reference ("orange-county", "Orange County"): the covered cities
    // inside it, per state, since several states share county names.
    const inCounty = refSlug
      ? covered.filter((c) => c.countySlug === refSlug || c.countySlug === `${refSlug}-county`)
      : [];
    return ok({
      found: false,
      city: cityRef,
      ...(stateHint ? { state: stateHint } : {}),
      message: `No covered city matches '${cityRef}'${stateHint ? ` in ${stateHint}` : ""}. UrbanKit covers ${covered.length} cities' code-violation, building-permit or zoning-case datasets; a city outside them has no dataset here, and its county may still be in the parcel atlas (find_county).`,
      ...(inState.length ? { cities_in_state: inState.map(citySummaryOut) } : {}),
      ...(inCounty.length ? { cities_in_county: inCounty.map(citySummaryOut) } : {}),
      hint: "Call get_city_datasets with no city (optionally with state or kind) to list every covered city.",
    });
  }

  if (matches.length > 1) {
    return ok({
      found: false,
      ambiguous: true,
      city: cityRef,
      matches: matches.map(citySummaryOut),
      hint: "Repeat with state ('TX' or 'Texas'), or pass the slug as city.",
    });
  }

  const entry = matches[0];
  // The slug comes from the registry's own summary, never from the caller's
  // text. Which records to read follows registry MEMBERSHIP, not the summary's
  // kinds, as on the hosted tool: the kinds a file declares are read from the file.
  const property = kind !== "zoning" ? getCityProperty(entry.slug) : undefined;
  const zoning = !kind || kind === "zoning" ? getCityZoning(entry.slug) : undefined;
  const descriptors = cityDatasets(entry.slug, kind);
  const record = property ?? zoning;

  if (!record || descriptors.length === 0) {
    const known = Array.from(
      new Set<string>([
        ...entry.kinds,
        ...(property ? Object.keys(property.datasets) : []),
        ...(getCityZoning(entry.slug) ? ["zoning"] : []),
      ]),
    );
    return ok({
      found: true,
      city: { ...citySummaryOut(entry), name: entry.city, state: entry.state },
      datasets: [],
      note: `${entry.city} has no${kind ? ` ${kind}` : ""} dataset in the registry; its kinds are ${known.join(", ")}.`,
    });
  }

  const datasets = descriptors.map((d) => {
    const used = streetForDataset(d, street);
    return {
      ...snakeKeys(d as unknown as Record<string, unknown>),
      freshness: snakeKeys(d.freshness),
      ...(used !== street ? { query_note: `${d.queryNote} ${SPLIT_ADDRESS_UNMAPPED_NOTE}` } : {}),
      // The exact URL the site sends for this street (street_used is what the
      // match runs on). Null when the lookup needs a geocoded point first:
      // query_template then carries the request with its {LON},{LAT}
      // placeholder. A street never appears in a template, because it has to be
      // escaped: query_url is the escaped form.
      ...(street ? { street_used: used, query_url: buildCityQuery(d, street) } : {}),
    };
  });

  const stateSlug = slugify(record.state);
  const countySlug = record.countySlug ?? entry.countySlug;

  return ok({
    found: true,
    city: {
      slug: entry.slug,
      name: record.city,
      state: record.state,
      state_abbrev: record.stateAbbrev,
      county_name: record.countyName ?? entry.countyName ?? null,
      county_slug: countySlug ?? null,
      atlas_county_page: countySlug ? `${CITY_BASE_URL}/parcel-atlas/${stateSlug}/${countySlug}` : null,
    },
    scope_note:
      property?.scopeNote ??
      `Records cover the city of ${record.city}, not the whole county; a county parcel's owner is a county-tool question.`,
    ...(street ? { street } : {}),
    datasets,
    source: sourceOut(record.source),
    ...(property && zoning && zoning.source.url !== property.source.url
      ? { zoning_source: sourceOut(zoning.source) }
      : {}),
    urbankit_pages: {
      property_report: property ? `${CITY_BASE_URL}${cityPath(entry.slug, "permits")}` : null,
      zoning_cases: zoning ? `${CITY_BASE_URL}${cityPath(entry.slug, "zoning")}` : null,
    },
    registry_urls: {
      property: property ? `${CITY_BASE_URL}/data/city-property/${entry.slug}.json` : null,
      zoning: zoning ? `${CITY_BASE_URL}/data/city-zoning/${entry.slug}.json` : null,
    },
    note: "Run query_url (or sample_query) yourself against the city's server: it answers with CORS and needs no key from UrbanKit. The registry JSON above is served with Access-Control-Allow-Origin: * too. This server runs no query itself.",
  });
}
