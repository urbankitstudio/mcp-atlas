[![Socket Badge](https://badge.socket.dev/npm/package/@urbankitstudio/mcp-atlas)](https://socket.dev/npm/package/@urbankitstudio/mcp-atlas)

# @urbankitstudio/mcp-atlas

[![mcp-atlas MCP server](https://glama.ai/mcp/servers/urbankitstudio/mcp-atlas/badges/card.svg)](https://glama.ai/mcp/servers/urbankitstudio/mcp-atlas)

Query the parcel ArcGIS REST endpoints of 503 counties across 51 US states (50 states plus DC), 498 endpoints total, for owner, APN and address lookup via the Model Context Protocol (MCP).

An [MCP](https://modelcontextprotocol.io) server that gives AI assistants direct access to UrbanKit Studio's atlas of manually verified county parcel GIS services. Ask Claude or Cursor to find the ArcGIS REST endpoint for any covered county, get the exact owner-search query URL, and look up parcel data — without needing to know anything about ArcGIS REST API conventions.

**Coverage:** 503 counties across 51 US states (50 states plus DC), 498 endpoints, 498 of them live (atlas 0.6.46). 471 of the counties have an endpoint; for the other 32 the atlas records why not (see "A county we cannot serve" below).

---

## Quick start

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "mcp-atlas": {
      "command": "npx",
      "args": ["-y", "@urbankitstudio/mcp-atlas"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project root (or `~/.cursor/mcp.json` globally):

```json
{
  "mcpServers": {
    "mcp-atlas": {
      "command": "npx",
      "args": ["-y", "@urbankitstudio/mcp-atlas"]
    }
  }
}
```

### Install globally (optional)

```sh
npm install -g @urbankitstudio/mcp-atlas
```

Then use `mcp-atlas` as the command instead of `npx -y @urbankitstudio/mcp-atlas`.

---

## Tools

The first four tools are one county pipeline, and what separates them is how
precisely you can already name the county. The fifth, `get_city_datasets`, is
separate: it answers about a city, not a county.

| You have | Use | You get |
|---|---|---|
| A state, or nothing | `list_counties` | Which counties are covered, and whether owner search works there. No URLs. |
| A vague, misspelled or FIPS reference | `find_county` | Every county that reference matches, named, each with its record |
| An exact state and county | `get_parcel_endpoint` | That one county's endpoint URL, layer, fields and sample query |
| A county and an owner's name | `build_owner_query` | A runnable URL that searches for that name |
| A city, and optionally a street | `get_city_datasets` | That city's code-violation, building-permit and zoning-case datasets, each with a runnable query URL |

`find_county` and `get_parcel_endpoint` return the same per-county record. They
differ in how you address the county: `find_county` accepts an uncertain
reference and may come back with several candidates, `get_parcel_endpoint`
takes an exact pair and answers about one. If you already know the county, skip
`find_county`.

This server never executes a query and returns no parcel records. It tells you
the URL to fetch; fetching it is yours to do.

### A county we cannot serve

`find_county`, `get_parcel_endpoint` and `build_owner_query` give one answer for
a county with no endpoint to hand back, the same text the hosted UrbanKit MCP
server, its REST API and the `uks` CLI give. It comes from
`coverageAnswer()` in `@urbankitstudio/atlas` 0.6.38:

- **The atlas has no record** (a misspelling lands here too): "This county is not
  in the UrbanKit atlas", with a prompt to check the spelling first.
- **The atlas records the county and it publishes nothing we can serve** (Shelby
  TN, whose terms bar public display; Columbia PA, whose layer has parcel numbers
  only): the reason in one sentence, the date we last checked, the date of the
  next check when one is set, the county's own office and, where the county sells
  the data, its own product.

Both end with a free request for the county: a ready body for `request_county`
on the hosted MCP server or `POST https://urbankitstudio.com/api/atlas/request`.
Requesting does not promise we add the county. `list_counties` still lists only
the counties we serve.

### `list_counties`

Browse coverage. Answers "is this county covered?" and "what can I search
there?" — one line per county, with no endpoint URLs or field names.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `state` | string | No | Two-letter abbreviation (`IL`) or full name (`Illinois`) |

**Example prompt:** "List all covered counties in Illinois"

**Example output:**
```
ST | County               | Slug                     | Coverage
--------------------------------------------------------------------
IL | Kane                 | kane-county              | owner+APN
IL | Cook                 | cook-county              | APN only
IL | DuPage               | dupage-county            | owner+APN
...
```

What each Coverage label promises:

| Label | Meaning |
|-------|---------|
| `owner+APN` | `build_owner_query` returns a URL for at least one endpoint |
| `APN only (county publishes no owner name)` | A reviewed record says the county serves no usable owner name |
| `location queries only` | No endpoint answers attribute searches; parcels are reached by geometry, which also returns owner fields |
| `APN only (owner column not searchable)` | An owner column exists but the county marks it unsearchable by name; a parcel-id or location query returns it |
| `APN only (confidential flag incomplete)` | An owner column exists, but the layer's confidential-owner flag is malformed, so no owner query is offered |
| `APN only` | No endpoint documents an owner column |

---

### `find_county`

Resolves a reference you cannot state exactly. Fuzzy-matches a partial or
misspelled name, a "County State" phrase, or a 5-digit FIPS code against every
covered county, and names each county it matched so an ambiguous reference
comes back as a list to choose from. Each match carries that county's record:
endpoint URLs, searchable field names, owner field, sample query, license.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | County name (`Kane`), name+state (`Kane IL`), or FIPS (`17089`) |

**Example prompt:** "Find the parcel endpoint for Kane County Illinois"

---

### `get_parcel_endpoint`

The default lookup once the county is known. Returns the full ArcGIS REST URL,
layer index, searchable fields, owner field (or why no owner query is offered),
the county's `Scope:` predicate when the layer is shared statewide or
regionally, a generic sample `?where=…&f=json` query and the UrbanKit deep-link
for one county. For a named owner, use
`build_owner_query` rather than editing the sample query by hand. On a layer
that flags confidential owners it prints the `Confidential flag:` exclusion
to AND into any query of your own, and prints its own sample owner query in
place of the atlas's, so the one sample shown carries this server's clauses.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `state` | string | Yes | Two-letter abbreviation or full name |
| `county` | string | Yes | County name (`Kane` or `Kane County`) |

**Example prompt:** "Give me the ArcGIS REST endpoint for Cook County Illinois"

---

### `build_owner_query`

The only tool that searches for a named owner. Fills a person or company name
into the county's verified owner/taxpayer field as
`UPPER(field) LIKE UPPER('%NAME%')`, a case-insensitive partial match, and
returns a URL you can fetch or open. On a shared statewide or regional layer
(Connecticut's regional composites, for example) the county's scope predicate
is ANDed in front, as
`(scope) AND UPPER(field) LIKE …`, so only that county's rows come back.

Some layers publish an owner whose record must not be shown, and flag it in a
column beside the owner: Texas Tax Code §25.025 lets peace officers, judges,
family-violence victims and others keep their home address confidential, and
Harris and Collin mark those accounts (Ector carries a forward guess). On such
a layer the query excludes flagged rows, as
`(…) AND UPPER(CAST(flag AS VARCHAR(255))) NOT LIKE '%Y%'`, a contains test
for every flag value (Harris packs one flag per ownership slot, `YNNNNNNNNN`).
SQL `UPPER` matches the atlas's uppercase rule on ASCII only, so each of the 17
non-ASCII characters whose uppercase holds an ASCII letter (`ß`, a dotless i,
the `ﬁ` ligatures, `ẙ` and the like) gets a clause of its own when it shares a
letter with a value: `CAST(flag AS VARCHAR(255)) NOT LIKE '%ẙ%'` drops a cell
holding one. Those clauses still lean on the county's database (an `UPPER` that
maps a-z to A-Z, a `LIKE` that reads past an embedded NUL, no cell cut off at the
255-character cast, one encoding for cell and literal), so the query ends with a
clause that does not: `flag IN (…)`, the exact raw cells the atlas lists as safe
(`confidentialFlag.safeValues`: Harris's blank and N runs, each 10 characters;
Collin `F`; Ector `0`). A row stays only when the database itself says its cell
equals one of those values, under its own comparison rules, so a NUL, a cut-off
cell or a value nobody has reviewed drops out. A backend that ignores trailing
spaces or case also keeps the same safe value padded differently or in another
case; none of those holds a flag value. A flag without safe values, or with one that holds a marker, offers no
owner query. On 2026-10-26 the `IN` clause kept exactly the rows the contains
clauses keep on all three layers (Harris 1,541,671, Collin 435,783, Ector
77,042), and those lists were each layer's complete distinct values.
A value longer than one character is a contains test too, which deliberately
excludes more than the atlas's trimmed-equality rule: for `SEALED`, the cells
` SEALED` and `UNSEALED` drop out as well. The cast lets one form serve a text
or an integer column, and UPPER on both sides compares the flag without regard
to case. A row with no flag recorded (NULL) counts as flagged and drops
out. The flag column comes back with each row; never show or pass on a row
whose flag is set.

An endpoint is refused, with the reason, rather than handed a query that finds
nothing, hangs, or serves confidential owners:

- a reviewed record says the county publishes no usable owner name;
- the layer serves no attribute search at all (query it by location instead);
- the owner column is not searchable by name (use a parcel-id or location query);
- the layer carries a confidential-owner flag that is present but incomplete
  (no column, no values, or a value that is not ASCII letters and digits
  only), so no exclusion can be built.

A refusal that points to a location, parcel-id or address read also prints the
layer's `Confidential flag:` line, and on a flagged layer its advice follows
the flag. With a well-formed flag, the read must request the flag column in
`outFields` and keep a row only when its flag cell is exactly one of the safe
values and contains no flag value, dropping every other row (a missing or NULL
cell included); a layer with no attribute search takes no where clause, so that
filtering is the reader's, and its `Confidential flag:` line gives that row
rule in place of "AND this into every query". With an incomplete flag, the refusal advises no
read at all: do not read owner fields on that layer. `find_county` and
`get_parcel_endpoint` carry the same advice in their `Confidential flag:` line,
and their Owner line says why no owner query is offered.

Every free-text argument of every tool refuses control characters (CR, LF,
TAB, NUL and the rest of U+0000 to U+001F, U+007F, and the C1 controls U+0080
to U+009F), the line and paragraph separators U+2028 and U+2029, and the whole
Unicode Bidi_Control set (U+061C, U+200E, U+200F, U+202A to U+202E and U+2066
to U+2069), so an argument echoed into an answer cannot start a line of its
own there or reorder how the text around it displays. Other invisible
characters, such as U+200B, U+FEFF and the soft hyphen U+00AD, still pass. A
validation error on a tool argument never repeats the value it refused (the
MCP SDK's own error for an unknown tool name does quote that name).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `state` | string | Yes | Two-letter abbreviation or full name |
| `county` | string | Yes | County name |
| `owner_name` | string | Yes | Owner/taxpayer name (partial match) |

**Example prompt:** "Build an ArcGIS query for properties owned by 'Smith' in Kane County IL"

**Example output:**
```
County:       Kane, Illinois
Owner field:  TaxName
WHERE clause: UPPER(TaxName) LIKE UPPER('%SMITH%')

Query URL:
https://gistech.countyofkane.org/arcgis/rest/services/KanePINList/MapServer/0/query
  ?where=UPPER(TaxName)%20LIKE%20UPPER('%25SMITH%25')
  &outFields=PIN,TaxName,SiteAddress,SiteCity,MailingAddress
  &returnGeometry=false&f=json&resultRecordCount=25
```

---

### `get_city_datasets`

City code-violation, building-permit and zoning-case datasets. Give a city
slug (`fort-worth`) or name (`Fort Worth`, `Fort Worth, TX`), optionally a
`kind` and a street line, and it returns each verified dataset for that city:
the endpoint and provider (Socrata, ArcGIS, CKAN or CARTO), the column the
address is matched on, the date field, any filter that is part of the dataset's
definition, coverage and freshness notes, and, when you pass a street, a ready
`query_url` to run against the city's own server. Omit `city` to list every
covered city.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `city` | string (max 80) | No | City slug or name; omit to list covered cities |
| `state` | string (max 40) | No | Two-letter code or state name, for a name used in two states |
| `kind` | `violations` \| `permits` \| `zoning` | No | Return only that kind of dataset |
| `street` | string (max 120) | No | Street line only, such as `Commerce` or `600 Commerce St`. Cut at the first comma, so a full address is safe to pass |

- A name shared by two cities comes back as `found: false, ambiguous: true` with
  the candidates; repeat with `state`. A city outside the registry comes back as
  `found: false` with the covered cities in its state, or in its county when the
  reference names one.
- `query_url` is `null` for a point lookup (a polygon docket or a current-zoning
  map); the dataset's `query_template` then carries the request with a
  `{LON},{LAT}` placeholder to fill in.
- Scope is the city's limits, not the county. These tables hold no owner data:
  for a parcel's owner, use the county tools above.
- Like the county tools, this one fetches nothing. It answers from the atlas
  package and hands you URLs to run yourself. Socrata throttles anonymous
  callers, so send your own `X-App-Token` header for volume.
- It is the same tool the hosted UrbanKit MCP serves, with the same advertised
  inputs and response keys. The stdio server holds arguments to that schema
  strictly: `kind` must be `violations`, `permits` or `zoning` in lower case.

**Example prompt:** "Where do I pull open building permits for 600 Commerce St, Dallas?"

**Example output (abridged):**
```json
{
  "found": true,
  "city": { "slug": "dallas", "name": "Dallas", "state_abbrev": "TX", "county_slug": "dallas-county" },
  "street": "600 Commerce St",
  "datasets": [
    {
      "kind": "permits",
      "provider": "socrata",
      "endpoint": "https://www.dallasopendata.com/resource/e7gq-4sah.json",
      "address_field": "street_address",
      "street_used": "600 Commerce St",
      "query_url": "https://www.dallasopendata.com/resource/e7gq-4sah.json?$where=upper(street_address)%20like%20upper('%25600%20Commerce%20St%25')&$limit=30"
    }
  ]
}
```

---

## Example conversation

> **User:** I'm doing due diligence on properties in Kane County, Illinois. Can you find all parcels owned by "Blackstone"?

> **Claude (using mcp-atlas):**
> 1. Calls `get_parcel_endpoint` → gets the `gistech.countyofkane.org` URL and confirms the owner field is `TaxName`
> 2. Calls `build_owner_query` with `owner_name=Blackstone` → returns a ready fetch URL
> 3. Optionally fetches the URL and formats the parcel results

---

## Atlas coverage

The atlas is maintained by [UrbanKit Studio](https://urbankitstudio.com/parcel-atlas). All endpoints are manually verified. Counties with an owner/taxpayer field support full name-based lookups; PIN-only counties support APN/parcel-number queries.

Full coverage map: https://urbankitstudio.com/parcel-atlas

---

## Data

Atlas data is embedded in the package (no network calls at startup). The underlying `@urbankitstudio/atlas` SDK is also published separately for programmatic use.

---

## What Socket flags, and how much of it is ours

[Socket](https://socket.dev/npm/package/@urbankitstudio/mcp-atlas)'s supply-chain scanner
rates this package in the mid-70s. Clicking through shows a long alert list. Each alert,
checked rather than waved away:

| Alert | Whose | What it is |
|---|---|---|
| `usesEval` | Not ours | No `eval` or `new Function` anywhere in `src/`. It comes from a dependency. |
| `unmaintained` (21) | Not ours | Transitive dependencies last published 2017–2021. |
| `mixedLicense` | Not ours | A dependency published as `BSD-3-Clause AND ISC`. |
| `noTests` | Ours, by design | `files` ships `dist` only. The suite lives in `test/` and runs in CI. Shipping tests inside the tarball would be the defect. |
| `networkAccess`, `filesystemAccess`, `envVars`, `shellAccess` | Ours | An MCP server talks to a client over stdio and reads its own config. A server without these could not do the job. |
| `unpopularPackage`, `noV1` | Ours | Download count and a `0.x` version. Both resolve with time, neither is a code issue. |

Vulnerability and license both come back at **100**, quality at **99**. The number the
badge shows is the *supply-chain* sub-score, and its single largest deduction is download
count, a popularity measure wearing a security badge's clothes. Judge the list above, not
the digit.

The four access alerts are what let the server read its own config and talk to a client
over stdio, nothing more. It still never executes a query or returns a parcel record.

## License

MIT — © 2026 UrbanKit Studio LLC
