#!/usr/bin/env node
/**
 * @urbankitstudio/mcp-atlas
 *
 * MCP server exposing UrbanKit Studio's verified county parcel ArcGIS REST atlas.
 * Runs over stdio — compatible with Claude Desktop, Cursor, and any MCP client.
 *
 * Tools:
 *   list_counties       – list covered counties (optional state filter)
 *   find_county         – fuzzy-match a county, return endpoints + searchable fields
 *   get_parcel_endpoint – return the full REST service URL + ready sample query
 *   build_owner_query   – construct exact ArcGIS REST query for an owner name
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import {
  atlas,
  atlasIndex,
  slugify,
  countySlugFromName,
} from "@urbankitstudio/atlas";
import {
  ownerSearchPolicy,
  ownerWhereClause,
  ownerCoverageLabel,
  escapeSqlLiteral,
  type OwnerSearchPolicy,
} from "./search-policy.js";

// Re-exported so the package's public surface is unchanged by the move.
export { escapeSqlLiteral };

const PKG_VERSION: string = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8"),
).version;

// This server carries no network tool of its own, so a county it does not hold
// is pointed at the hosted request path instead (free; UKS PR #941, 2026-10-06).
const REQUEST_COUNTY_HINT =
  'This county is not in the UrbanKit atlas yet. You can request it, free: POST {"county_fips": "<5 digits>"} ' +
  '(or {"state": "<state-slug>", "county": "<county-slug>"}, optional "requester_email", "note", "source_url") ' +
  "to https://urbankitstudio.com/api/atlas/request, or call the hosted MCP tool request_county at https://urbankitstudio.com/api/mcp.";
import type { CountyRecord, EndpointRecord } from "@urbankitstudio/atlas";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Whether an owner query is offered, and how it is scoped, is decided ONLY in
// ./search-policy.ts. Matching the column name is not enough, and that gap cost
// a real trial user: they paid for owner data, ran Los Angeles County, got
// nothing back, and the atlas had said the field was there the whole time.

/** The Owner/Attribute line shared by find_county and get_parcel_endpoint. */
function ownerLine(owner: OwnerSearchPolicy): string {
  if (owner.field) return `Owner field: ${owner.field}`;
  if (owner.kind === "attribute_search_unsupported") {
    return `Attribute search: not offered (location queries only) - ${owner.reason}`;
  }
  if (owner.kind === "owner_unsearchable") {
    return "Owner field: not searchable by name (column exists; use a parcel-id or location query)";
  }
  return owner.reason
    ? `Owner field: NOT AVAILABLE - ${owner.reason}`
    : "Owner field: NONE - this layer publishes no owner column";
}

/** A shared layer's county predicate, printed so a caller ANDs it into any query of their own. */
function scopeLine(owner: OwnerSearchPolicy): string | null {
  return owner.scopeWhere
    ? `Scope: ${owner.scopeWhere} (shared layer; AND this into every query)`
    : null;
}

function buildArcgisOwnerQuery(
  endpoint: EndpointRecord,
  owner: OwnerSearchPolicy,
  ownerQuery: string,
): string {
  if (!owner.field) return "";
  const where = encodeURIComponent(ownerWhereClause(owner.field, owner.scopeWhere, ownerQuery));
  const liveFields = endpoint.searchFields
    .filter((sf) => sf.searchable)
    .map((sf) => sf.name)
    .join(",");
  return (
    `${endpoint.url}/query` +
    `?where=${where}` +
    `&outFields=${liveFields}` +
    `&returnGeometry=false` +
    `&f=json` +
    `&resultRecordCount=25`
  );
}

function formatCountySummary(c: CountyRecord): string {
  const epSummary =
    c.endpoints.length === 0
      ? "no REST endpoint mapped"
      : c.endpoints
          .map((ep) => {
            const owner = ownerSearchPolicy(c, ep);
            const searchable = ep.searchFields
              .filter((sf) => sf.searchable)
              .map((sf) => `${sf.name} (${sf.label})`)
              .join(", ");
            const scope = scopeLine(owner);
            return [
              `  URL: ${ep.url}`,
              `  Service: ${ep.serviceType}/layer ${ep.layerIndex}`,
              `  Status: ${ep.status} (verified ${ep.lastVerified})`,
              ...(scope ? [`  ${scope}`] : []),
              `  Searchable fields: ${searchable || "none"}`,
              `  ${ownerLine(owner)}`,
              `  License: ${ep.license}`,
            ].join("\n");
          })
          .join("\n---\n");
  return [
    `${c.county}, ${c.stateName} (${c.state})`,
    `FIPS: ${c.countyFips ?? "n/a"}`,
    `Endpoints (${c.endpoints.length}):`,
    epSummary,
    c.notes ? `Notes: ${c.notes}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer(
  // Read from package.json rather than restated here. This line said 0.1.0
  // while the package was 0.1.6 - six releases of drift, and every MCP client
  // that asked the server its version got the wrong answer.
  { name: "mcp-atlas", version: PKG_VERSION },
  {
    instructions:
      "UrbanKit Atlas MCP server. Use list_counties to discover coverage, find_county or get_parcel_endpoint to get the ArcGIS REST URL, and build_owner_query to construct a ready-to-fire owner-name lookup URL.",
  }
);

// ---------------------------------------------------------------------------
// Tool: list_counties
// ---------------------------------------------------------------------------

server.registerTool(
  "list_counties",
  {
    title: "List covered counties",
    description:
      `Browse what the atlas covers. Answers "is this county covered?" and "what can I search there?" with one line per county: state, name, slug, and whether owner-name search is available or the county publishes parcel numbers only. Deliberately returns NO endpoint URLs or field names; call get_parcel_endpoint for one county's technical record. Filter with a state abbreviation ('IL') or name ('Illinois'), or omit state for all ~${atlas.totals.counties} counties.`,
    inputSchema: {
      state: z
        .string()
        .optional()
        .describe(
          "Optional: two-letter state abbreviation (e.g. 'IL') or full state name (e.g. 'Illinois')"
        ),
    },
  },
  ({ state }) => {
    const stateFilter = state?.trim().toLowerCase();

    const rows: string[] = [];

    for (const stateEntry of atlasIndex.states) {
      if (!stateEntry.populated) continue;

      // Filter by state if provided
      if (stateFilter) {
        const matchAbbrev = stateEntry.abbrev.toLowerCase() === stateFilter;
        const matchName = stateEntry.name.toLowerCase() === stateFilter;
        const matchSlug = stateEntry.slug === slugify(stateFilter);
        if (!matchAbbrev && !matchName && !matchSlug) continue;
      }

      const stateFile = atlas.byStateSlug.get(stateEntry.slug);
      if (!stateFile) continue;

      const covered = stateFile.counties.filter(
        (c) => c.endpoints.length > 0
      );
      for (const c of covered) {
        // A caller scanning this column is deciding whether to spend a request.
        // ownerCoverageLabel documents what each label promises; "owner+APN"
        // means build_owner_query will actually return a URL.
        const ownerCoverage = ownerCoverageLabel(c);
        rows.push(
          `${c.state} | ${c.county.padEnd(20)} | ${c.countySlug.padEnd(24)} | ${ownerCoverage}`
        );
      }
    }

    if (rows.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: stateFilter
              ? `No covered counties found for state "${state}". Check state name/abbreviation.`
              : "No counties found (unexpected — check atlas data).",
          },
        ],
      };
    }

    const header =
      "ST | County               | Slug                     | Coverage";
    const divider = "-".repeat(header.length);
    const totals = `\nTotal: ${rows.length} counties`;

    return {
      content: [
        {
          type: "text" as const,
          text: [header, divider, ...rows, divider, totals].join("\n"),
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: find_county
// ---------------------------------------------------------------------------

server.registerTool(
  "find_county",
  {
    title: "Resolve an uncertain county reference",
    description:
      "Use when you do NOT already know the exact state and county. Fuzzy-matches one free-text reference ('Kane', 'Cook County IL', a misspelling, or a 5-digit FIPS code) against every covered county and names each county it matched, so an ambiguous reference comes back as a list to choose from rather than a silent guess. Each match carries that county's technical record, the same record get_parcel_endpoint returns for one county. Call get_parcel_endpoint directly whenever you already hold an exact state and county; come here only to turn a vague, misspelled or coded reference into definite ones.",
    inputSchema: {
      query: z
        .string()
        .min(2)
        .describe(
          "County name, 'County Name State' (e.g. 'Kane IL'), or 5-digit FIPS code"
        ),
    },
  },
  ({ query }) => {
    const q = query.trim().toLowerCase();

    // FIPS lookup
    const isFips = /^\d{5}$/.test(q);

    const matches: CountyRecord[] = [];

    for (const stateEntry of atlasIndex.states) {
      if (!stateEntry.populated) continue;
      const stateFile = atlas.byStateSlug.get(stateEntry.slug);
      if (!stateFile) continue;

      for (const county of stateFile.counties) {
        if (isFips) {
          if (county.countyFips === q) matches.push(county);
          continue;
        }

        // Parse optional state suffix: "Kane IL" or "Kane Illinois"
        let countyPart = q;
        let statePart: string | null = null;
        const spaceIdx = q.lastIndexOf(" ");
        if (spaceIdx > 0) {
          const last = q.slice(spaceIdx + 1);
          if (last.length === 2 || last.length > 3) {
            countyPart = q.slice(0, spaceIdx);
            statePart = last;
          }
        }

        if (statePart) {
          const stateOk =
            stateEntry.abbrev.toLowerCase() === statePart ||
            stateEntry.name.toLowerCase() === statePart ||
            stateEntry.slug === slugify(statePart);
          if (!stateOk) continue;
        }

        const slug = countySlugFromName(countyPart);
        if (
          county.countySlug === slug ||
          county.county.toLowerCase() === countyPart ||
          county.county.toLowerCase().startsWith(countyPart)
        ) {
          matches.push(county);
        }
      }
    }

    if (matches.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `No county matched "${query}".\n` +
              `Try: "Kane IL", "Cook County IL", "17031" (FIPS), or use list_counties to browse.\n` +
              REQUEST_COUNTY_HINT,
          },
        ],
      };
    }

    const text = matches.map(formatCountySummary).join("\n\n" + "=".repeat(60) + "\n\n");

    return {
      content: [
        {
          type: "text" as const,
          text: matches.length > 1 ? `${matches.length} matches:\n\n${text}` : text,
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: get_parcel_endpoint
// ---------------------------------------------------------------------------

server.registerTool(
  "get_parcel_endpoint",
  {
    title: "Get one county's parcel endpoint record",
    description:
      "The default lookup once the county is known. Takes an exact state and county and returns that county's ArcGIS REST service URL, layer index, searchable field names, verified owner/taxpayer field (or why no owner query is offered), the county's Scope predicate when the layer is shared statewide or regionally (AND it into any query of your own), a generic sample ?where=…&f=json query, and the UrbanKit deep-link. If the county name is uncertain, misspelled, or you hold only a FIPS code, call find_county first. To search for a named person or company, call build_owner_query rather than editing the sample query by hand.",
    inputSchema: {
      state: z
        .string()
        .describe("Two-letter state abbreviation (e.g. 'IL') or full state name"),
      county: z
        .string()
        .describe("County name (e.g. 'Kane' or 'Kane County')"),
    },
  },
  ({ state, county }) => {
    const stateSlug = slugify(state.trim());
    const countySlug = countySlugFromName(county.trim());

    // Try exact slug match first, then abbrev match
    let countyRecord: CountyRecord | undefined;

    for (const stateEntry of atlasIndex.states) {
      if (!stateEntry.populated) continue;
      const abbrevMatch =
        stateEntry.abbrev.toLowerCase() === state.trim().toLowerCase();
      const slugMatch = stateEntry.slug === stateSlug;
      const nameMatch = stateEntry.name.toLowerCase() === state.trim().toLowerCase();
      if (!abbrevMatch && !slugMatch && !nameMatch) continue;

      const stateFile = atlas.byStateSlug.get(stateEntry.slug);
      if (!stateFile) continue;

      countyRecord = stateFile.counties.find(
        (c) => c.countySlug === countySlug
      );
      if (countyRecord) break;
    }

    if (!countyRecord) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `County "${county}" not found in state "${state}".\n` +
              `Use list_counties or find_county to verify the name.\n` +
              REQUEST_COUNTY_HINT,
          },
        ],
      };
    }

    if (countyRecord.endpoints.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `${countyRecord.county}, ${countyRecord.stateName} is in the atlas but has no verified REST endpoint yet.`,
          },
        ],
      };
    }

    const lines: string[] = [
      `${countyRecord.county} County, ${countyRecord.stateName} (${countyRecord.state})`,
      `FIPS: ${countyRecord.countyFips ?? "n/a"}`,
      "",
    ];

    countyRecord.endpoints.forEach((ep, i) => {
      const owner = ownerSearchPolicy(countyRecord, ep);
      const ownerField = owner.field;
      const sampleOwnerUrl = ownerField
        ? buildArcgisOwnerQuery(ep, owner, "SMITH")
        : null;
      const scope = scopeLine(owner);

      lines.push(`Endpoint ${i + 1}:`);
      lines.push(`  URL:         ${ep.url}`);
      lines.push(`  Service:     ${ep.serviceType}`);
      lines.push(`  Layer index: ${ep.layerIndex}`);
      lines.push(`  Layer name:  ${ep.layerName}`);
      lines.push(`  Status:      ${ep.status} (verified ${ep.lastVerified})`);
      lines.push(`  CORS:        ${ep.corsEnabled === null ? "unknown" : ep.corsEnabled}`);
      lines.push(`  License:     ${ep.license}${ep.licenseUrl ? ` (${ep.licenseUrl})` : ""}`);
      if (scope) lines.push(`  ${scope}`);
      lines.push("");
      lines.push("  Searchable fields:");
      ep.searchFields
        .filter((sf) => sf.searchable)
        .forEach((sf) => lines.push(`    ${sf.name.padEnd(20)} – ${sf.label}`));
      lines.push("");
      lines.push(`  ${ownerLine(owner)}`);
      if (ep.sampleQuery) {
        lines.push("");
        lines.push("  Sample query (from atlas):");
        lines.push(`    ${ep.sampleQuery}`);
      }
      if (sampleOwnerUrl) {
        lines.push("");
        lines.push('  Sample owner query (SMITH — replace with target name):');
        lines.push(`    ${sampleOwnerUrl}`);
      }
      lines.push("");
      lines.push(
        `  UrbanKit deep-link: https://urbankitstudio.com/tools/parcel-lookup?endpoint=${encodeURIComponent(ep.url)}${ownerField ? `&fieldHint=${ownerField}` : ""}`
      );
      if (i < countyRecord.endpoints.length - 1) lines.push("\n" + "-".repeat(40));
    });

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: build_owner_query
// ---------------------------------------------------------------------------

server.registerTool(
  "build_owner_query",
  {
    title: "Build an owner-name search URL for one county",
    description:
      "The only tool that searches for a named owner. Fills a person or company name into that county's verified owner/taxpayer field as UPPER(field) LIKE UPPER('%NAME%'), a case-insensitive partial match, and returns a URL you can fetch or open in a browser. On a shared statewide or regional layer the county's scope predicate is ANDed in front, as (scope) AND UPPER(field) LIKE …, so only that county's rows come back. get_parcel_endpoint returns the endpoint and a generic sample query, not a name search, so come here for the name. This server does not execute the query and returns no parcel records: fetch the returned URL yourself. An endpoint is refused, with the reason, when a reviewed record says the county publishes no owner name, when the layer serves no attribute search (query it by location instead), or when its owner column is not searchable by name (use a parcel-id or location query instead).",
    inputSchema: {
      state: z
        .string()
        .describe("Two-letter state abbreviation (e.g. 'IL') or full state name"),
      county: z
        .string()
        .describe("County name (e.g. 'Kane' or 'Kane County')"),
      owner_name: z
        .string()
        .min(2)
        .describe("Owner/taxpayer name to search for (partial match, case-insensitive)"),
    },
  },
  ({ state, county, owner_name }) => {
    const stateInput = state.trim();
    const countySlug = countySlugFromName(county.trim());

    let countyRecord: CountyRecord | undefined;

    for (const stateEntry of atlasIndex.states) {
      if (!stateEntry.populated) continue;
      const abbrevMatch =
        stateEntry.abbrev.toLowerCase() === stateInput.toLowerCase();
      const slugMatch = stateEntry.slug === slugify(stateInput);
      const nameMatch =
        stateEntry.name.toLowerCase() === stateInput.toLowerCase();
      if (!abbrevMatch && !slugMatch && !nameMatch) continue;

      const stateFile = atlas.byStateSlug.get(stateEntry.slug);
      if (!stateFile) continue;

      countyRecord = stateFile.counties.find(
        (c) => c.countySlug === countySlug
      );
      if (countyRecord) break;
    }

    if (!countyRecord) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `County "${county}" not found in state "${state}". Use find_county to verify.\n` +
              REQUEST_COUNTY_HINT,
          },
        ],
      };
    }

    const results: string[] = [];

    for (const ep of countyRecord.endpoints) {
      const owner = ownerSearchPolicy(countyRecord, ep);
      const ownerField = owner.field;
      if (!ownerField) {
        // Refusing with the reason beats handing back a query that returns zero
        // rows forever, or one that hangs. The caller can then choose a
        // different county or query instead of concluding the owner is absent.
        const place = `${countyRecord.county}, ${countyRecord.stateName}`;
        let refusal: string;
        switch (owner.kind) {
          case "attribute_search_unsupported":
            refusal = `OWNER SEARCH NOT OFFERED on this layer for ${place}: ${owner.reason}\nNo where-clause query is possible here. Query the layer by location (a point or envelope geometry) to read the owner fields of the parcels there.`;
            break;
          case "owner_unsearchable":
            // The owner IS published; only a name search on it is unsupported.
            refusal = `OWNER COLUMN NOT SEARCHABLE BY NAME for ${place}: ${owner.reason}\nUse a parcel-id or location query instead; either returns the owner of the matching parcel.`;
            break;
          case "reviewed_unservable":
            refusal = `OWNER NAME NOT AVAILABLE for ${place}: ${owner.reason}\nNo owner query is possible here. Search by parcel number or address instead, or pick a county whose coverage reads owner+APN in list_counties.`;
            break;
          default:
            refusal = "Note: this layer publishes no owner or taxpayer column - PIN-only lookup. Try searching by parcel number instead.";
        }
        results.push(`Endpoint: ${ep.url}\n${refusal}`);
        continue;
      }

      const queryUrl = buildArcgisOwnerQuery(ep, owner, owner_name);
      const where = ownerWhereClause(ownerField, owner.scopeWhere, owner_name);
      const scope = scopeLine(owner);

      results.push(
        [
          `County:      ${countyRecord.county}, ${countyRecord.stateName}`,
          `Owner field: ${ownerField}`,
          ...(scope ? [scope] : []),
          `WHERE clause: ${where}`,
          ``,
          `Query URL:`,
          queryUrl,
          ``,
          `Notes:`,
          `  - Returns up to 25 records`,
          `  - Partial name match (e.g. "SMITH" matches "SMITH JOHN" and "BLACKSMITH LLC")`,
          `  - Case-insensitive`,
          `  - Add &token=<your-token> if the service requires auth (this county is public)`,
        ].join("\n")
      );
    }

    if (results.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `${countyRecord.county}, ${countyRecord.stateName} has no REST endpoints in the atlas yet.`,
          },
        ],
      };
    }

    return {
      content: [{ type: "text" as const, text: results.join("\n\n" + "=".repeat(60) + "\n\n") }],
    };
  }
);

// ---------------------------------------------------------------------------
// Connect and run
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // MCP protocol runs over stdin/stdout; stderr is safe for diagnostics
  process.stderr.write("mcp-atlas server started (stdio)\n");
}

main().catch((err: unknown) => {
  process.stderr.write(
    `mcp-atlas fatal error: ${err instanceof Error ? err.message : String(err)}\n`
  );
  process.exit(1);
});
