# @urbankitstudio/mcp-atlas Changelog

This package did not previously carry a changelog. 0.1.0 through 0.1.5 below
are reconstructed from `npm view @urbankitstudio/mcp-atlas@<version>` metadata
and tarball diffs (`npm pack` + `diff`) during the 2026-07-20 repo
reconciliation, since none of those publishes had a corresponding commit in
this monorepo to draw from.

## 0.3.8 — 2026-10-18

Atlas ^0.6.38, and the coverage answer. A county this server cannot serve now gets the
answer the hosted MCP server, the REST API and the `uks` CLI give, from the atlas
package's `coverageAnswer()`, instead of "No county matched" or "no REST endpoint mapped".

- `find_county`, `get_parcel_endpoint` and `build_owner_query`, for a county the atlas has
  no record of: "This county is not in the UrbanKit atlas", a prompt to check the spelling,
  and a request. The request is a ready body (by FIPS code, or by state and county slug) when
  the state is known; free text or a state that names no state ("Nowhere County ZZ", "Ill.")
  gets the FIPS-code template instead, and is never sent as the request's `state_slug`.
- The same three tools, for a county the atlas records without a public endpoint (27 of
  them, Shelby TN among them): the reason in one sentence, the date we last checked, the next
  planned check when one is set, the county's own office and paid product where it has them,
  and the same request body. `find_county` still prints the record's notes after it.
- Fix: `find_county` reads the state suffix of a query properly. The last two words count as
  the state when they name one ("Kings New York", "Kanawha West Virginia"), else the last word
  does, and only when it names a state (an abbreviation, a name or a slug). Before, any last
  word of two or more than three letters counted, so "Kane County", "Orleans Parish" and
  "Los Angeles" matched nothing, "Kanawha West Virginia" read as the state Virginia, and the
  not-in-atlas answer would have told an agent to request counties the atlas serves. A comma
  or a tab between words is a space ("Cook County, IL", "Kane<tab>IL"). A query shorter than
  two characters once trimmed gets a one-line error instead of every record.
- Served counties print exactly what they printed before. `list_counties` still lists served
  counties only; "served" is now the package's `countyHasEndpoint()`, which agrees with the
  old endpoint-count test on all 494 records.
- `build_owner_query` for a county with no endpoint used to say "has no REST endpoints in the
  atlas yet"; it now gives the coverage answer, and that dead branch is gone.
- Coverage: 494 counties and 494 endpoints, 493 of them live; 467 counties have an endpoint
  (was 479 counties, same endpoints). Fifteen counties are newly recorded with their reason.

No tool name, schema or description change.

## 0.3.7 — 2026-10-17

Data update: atlas ^0.6.37.

- North Carolina: 83 counties added from the statewide parcel set, plus Union County, Ohio.
- Endpoints that served another county's parcels are fixed. Fayette KY (Lexington) now
  uses LFUCG's own layer and Summit OH its correct layer. Jackson MO and Montgomery OH list
  no endpoint until a correct one is verified.
- Shelby County, Tennessee no longer lists an endpoint: it is withheld pending written
  consent from Shelby County ReGIS. `find_county` still returns the record, with the
  reason in its notes; `get_parcel_endpoint` and `build_owner_query` return no URL for it.
- The ten Colorado county records served from the State of Colorado Public Parcels
  service carry the State's attribution line (Denver, on its own service, does not need it).
- Coverage: 479 counties and 494 endpoints, 493 of them live (was 395, 413 and 412).

No tool, schema or API change.

## 0.3.6 — 2026-10-17

Fix: the request hint on a county miss (find_county, get_parcel_endpoint, build_owner_query) told agents to POST {"state", "county"} to /api/atlas/request. That endpoint keeps only county_fips, or state_slug + county_slug, so the advertised body failed with 400 county-required. The hint now names state_slug and county_slug, and the smoke test asserts the keys, not only the URL. Found by the UKS coverage build reading this repo.

## 0.3.5 — 2026-10-14

Data update: atlas ^0.6.36.

- `get_city_datasets` reads a typed address with a house number the same way across
  city datasets, through atlas's `buildCityQuery`. On the three datasets that keep the
  number and the street in separate columns (Los Angeles violations, Fort Worth permits,
  Scottsdale violations), `2600 South Blvd` now searches the street `South`, `1700 E Q St`
  searches `Q`, and `100 N Court` searches `Court`, where before they searched the
  street type or the direction. An input with no street left to search (`100 %`) is
  searched as typed and finds no rows, instead of unrelated rows at that number.
- Coverage is unchanged: 395 counties and 413 endpoints, 412 of them live.

No tool, schema or API change.

## 0.3.4 — 2026-10-14

Data update: atlas ^0.6.35.

- `get_city_datasets` builds a more tolerant street match, through atlas's
  `buildCityQuery`: it now finds records in the five city datasets where an exact
  street string missed, for example Orlando's double-spaced addresses.
- One new county, Montgomery TN (47125), with parcel id and situs address only.
  Its public parcel layer has no owner fields, so owner lookups return nothing there.
- Coverage is now 395 counties and 413 endpoints, 412 of them live.

No tool, schema or API change.

## 0.3.3 — 2026-10-14

Data update: atlas ^0.6.34, which covers Mississippi statewide (all 82 counties).
Coverage is now 394 counties and 412 endpoints, 411 of them live, up from 314
counties and 331 endpoints. No tool, schema or API change.

## 0.3.2 — 2026-10-14

Data update: atlas ^0.6.33, which carries city data only. `get_city_datasets` now
answers for 30 cities with code-violation or building-permit datasets (up from
20) and 19 with zoning-case dockets (up from 17), Los Angeles among the new ones.
Every new dataset carries `latestRecordDate`. County coverage is unchanged:
314 counties and 331 endpoints, 330 of them live. No tool, schema or API change.

## 0.3.1 — 2026-10-14

Data update: atlas ^0.6.32, 314 counties and 331 endpoints, 330 of them live.
Eight new counties, all ones that callers had asked for and the atlas did not
carry. Berks PA, Bedford PA, Salem city VA, Nueces TX, Hidalgo TX, Brazos TX
and Ector TX each come with a verified endpoint. Webb TX is a researched stub
with no public REST. No tool, schema or API change; the five tools answer
exactly as in 0.3.0, over more counties.

## 0.3.0 — 2026-10-13
New tool: `get_city_datasets`, a fifth tool beside the four county tools. Given a
city (slug or name, state optional), an optional kind (`violations`, `permits`
or `zoning`) and an optional street, it returns the verified city
code-violation, building-permit and zoning-case datasets: provider, endpoint,
address and date columns, scope filter, coverage and freshness notes, and a
ready `query_url` for the street. With no city it lists every covered city. It
is the stdio twin of the hosted UrbanKit MCP tool of the same name: the same
inputs and caps (city 80, state 40, street 120 characters; the same kind enum),
the same street handling (cut at the first comma, trimmed), and the same
snake_case response keys for the list, found, ambiguous and not-found answers.
One difference: the stdio server validates arguments against the advertised
schema before the tool runs, so `kind` must be one of the three lower-case
values and an over-length or non-string argument is refused with an input
error; the hosted tool is more lenient (it lower-cases `kind` and trims).
Dependency: atlas ^0.6.31, which adds the city exports (`listCities`,
`findCity`, `cityDatasets`, `buildCityQuery` and others). The atlas county data
is unchanged (306 counties, 324 endpoints, 323 of them live). Like the county
tools it fetches nothing: it answers from the bundled registry and returns URLs
for the caller to run. The four existing tool descriptions and schemas are
unchanged byte for byte; the server `instructions` text now mentions the new
tool. `npm run test:policy` also runs the new `test/city-datasets.test.mjs`.

## 0.2.27 — 2026-10-13
Dependency update: atlas ^0.6.30. The atlas data is unchanged (306 counties,
324 endpoints, 323 of them live). The package adds an optional record field,
`supportsPagination: false`, for a layer that refuses `resultRecordCount` and
`resultOffset`, and an `offersPagination` reader for it; no bundled record
carries the flag yet. Behaviour: `get_parcel_endpoint` and `build_owner_query`
now leave `resultRecordCount=25` off the query URL of a layer flagged
`supportsPagination: false` (it would answer HTTP 200 with a 400 error body),
and `build_owner_query` says that the layer does not paginate and names its
`maxRecordCount`. Paginating layers are unchanged byte for byte. No tool
description or schema change.

## 0.2.26 — 2026-10-12
Data update: atlas ^0.6.29, 306 counties and 324 endpoints, 323 of them
live. New counties: Racine WI and Westmoreland PA, each with a live
endpoint. Casey KY is recorded as having no public REST service, so it is
listed without an endpoint. No tool or API change.

## 0.2.25 — 2026-10-12
Security: dependency advisories cleared. `@modelcontextprotocol/sdk` moves to
^1.32.1 (GHSA-6qxp-vccf-f47h, OAuth client credentials), and the lockfile
resolves proxy-addr 2.0.8 (GHSA-jqcg-44mw-7w3h), fast-uri 3.1.8, hono,
ip-address and qs to patched releases; `npm audit` reports 0 vulnerabilities.
This server is stdio-only, so none of the affected code paths were reachable.
No tool or API change.

## 0.2.24 — 2026-10-11
Data update: atlas ^0.6.28. Notes only: county notes now record that rows
carrying a RESTRICTED owner marker are withheld. Still 303 counties and 322
endpoints, 321 of them live. No tool or API change.

## 0.2.23 — 2026-10-11
Data update: atlas ^0.6.27, 303 counties and 322 endpoints, 321 of them
live. New counties: Adams, Arapahoe, Boulder, Douglas, Larimer, Mesa, Park
and Weld CO; Gallatin MT; Brunswick, Iredell, Johnston, New Hanover, Onslow
and Union NC; Berkeley and Wood WV. New York State's own query service has
hung since 2026-10-09; Onondaga, Suffolk and Westchester now try the
official NYSGIS mirror first, and the NYC boroughs try it third. No tool or
API change.

## 0.2.22 — 2026-10-10
Data update: atlas ^0.6.25, 286 counties and 297 endpoints, 296 of them
live. New counties are Clay, Craighead, Faulkner, Garland, Saline and
Sebastian AR. No tool or API change.

## 0.2.21 — 2026-10-10
Registry only. The MCP Registry name moves from `io.github.LEOyrh/mcp-atlas`
to `io.github.urbankitstudio/mcp-atlas` (`mcpName` and `server.json`), and
the publish workflow now updates the registry on every release over GitHub
OIDC instead of by hand. The registry entry had stopped at 0.2.3. No tool,
API or data change.

## 0.2.20 — 2026-10-10
Data update: atlas ^0.6.24, 280 counties and 291 endpoints, 290 of them
live. New counties are Chester PA, Gaston NC and Clark WA. No tool or API
change.

## 0.2.19 — 2026-10-10
Data update: atlas ^0.6.23, 277 counties and 288 endpoints, 287 of them
live. New counties are Greene MO, Georgetown SC, Hill TX and James City
County VA. No tool or API change.

## 0.2.18 — 2026-10-10
Data update: atlas ^0.6.22, 273 counties and 284 endpoints, 283 of them
live. Sixteen Kentucky counties are new: Boone, Clark, Daviess, Franklin,
Henderson, Henry, Jefferson, Madison, McCracken, Meade, Montgomery, Oldham,
Shelby, Simpson, Warren and Webster. No tool or API change.

## 0.2.17 — 2026-10-10

Data update: atlas ^0.6.21, 257 counties and 268 endpoints, 267 of them
live. New counties are Lyon NV, Humboldt CA and Fresno CA (Fresno serves
parcels with owner data withheld). No tool or API change.

The README coverage line now counts live endpoints. 0.2.16 said "247 of
them verified", but 247 was the number of counties with a live endpoint,
not a count of endpoints, and every endpoint carries a verification date.

## 0.2.16 — 2026-10-08

Data update: atlas ^0.6.20, 254 counties and 265 endpoints (247 with a
verified endpoint). New counties are Chesterfield VA, Newport News VA,
Bradford PA and Montgomery NC, and Dutchess NY is listed with no public
REST endpoint. No tool or API change.

## 0.2.15 — 2026-10-06

No data change (atlas stays ^0.6.19, 249 counties, 261 endpoints). The not-found
hint now tells the agent what to do with the request path, not only where it is:
offer to request the county for the person it is helping; if they say yes, POST
the body or call the hosted `request_county` tool, adding their email if they
want to be told when it ships. Requesting is free. Same wording as the hosted
MCP's not-indexed answer.

## 0.2.14 — 2026-10-06

No data change (atlas stays ^0.6.19, 249 counties, 261 endpoints). Every
"county not found" answer from `find_county`, `get_parcel_endpoint` and
`build_owner_query` now ends with how to request the county, free:

- `POST {"county_fips": "<5 digits>"}` (or `{"state": "<state-slug>",
  "county": "<county-slug>"}`, optional `requester_email`, `note`, `source_url`)
  to `https://urbankitstudio.com/api/atlas/request`, or the hosted MCP tool
  `request_county` at `https://urbankitstudio.com/api/mcp`.
- Slugs are strict (lowercase, single hyphens). A repeat of the same county
  from the same requester within 24 h returns the first request's id.
- This stdio server carries no network tool of its own, so it points at the
  hosted path instead of taking the request itself.

## 0.2.13 — 2026-10-06

Dependency bump to atlas ^0.6.19 (249 counties, 261 endpoints, 243 with a
verified endpoint). 0.6.19 adds one county, no API change, no breaking change:

- New county: Polk OR (41053), on the County's own ArcGIS web adaptor
  (CORS open). Indexed from a request; the record carries the County's
  outreach note.

## 0.2.12 — 2026-10-06

Dependency bump to atlas ^0.6.18 (248 counties, 260 endpoints, 242 with a
verified endpoint). 0.6.18 adds one county, no API change, no breaking change:

- New county: Mendocino CA (06045), the County's own ArcGIS Online layer
  (`Parcels_Public_`, 62,051 parcels, data last edited 2026-06-08, CORS open).
  APN, the 10-character APNFULL and the situs address are searchable. The
  public layer publishes no owner name and no owner mailing address, so the
  record carries an `ownerFieldNote` and `not_published` capability overrides
  for both; an owner search returns nothing for this county.

## 0.2.11 — 2026-10-05

Dependency bump to atlas ^0.6.17 (247 counties, 259 endpoints, 241 with a
verified endpoint). 0.6.17 adds one county and one optional field, no breaking
change:

- New county: Schenectady NY (36093), a vendor-hosted Spatial Data Logic layer
  with owner names published, print key, situs and owner mailing address; a
  `dataVintage` advisory because the layer's last edit date is 2023-09-28.
- New field: `CountyRecord.addedAt?: string | null`, the ISO day a county
  entered the atlas. It never moves once stamped; Schenectady is the first.
  This server passes records through, so the field is visible to clients and
  nothing here reads it.
- Re-checked, still no public REST: Iron MI (26071), Garfield OK (40047).

## 0.2.10 — 2026-10-04

Dependency catch-up to atlas ^0.6.16 (246 counties, 258 endpoints). 0.6.16 is
a data refresh with no API change and no new counties. Five New Jersey county
records (Bergen, Essex, Ocean, Camden, Morris) on the two NJOGIS statewide
services now state what those services serve: owner-name availability, the
mailing-address columns and the PAMS_PIN label. All 67 Florida registrations
on the FDOR statewide cadastral replace a `sampleQuery` the layer rejects with
one scoped to the county. No code changes. The totals in `README.md`,
`package.json` and `server.json` are unchanged at 246 / 258.

## 0.2.9 — 2026-10-04

Dependency catch-up to atlas ^0.6.15 (246 counties, 258 endpoints). Orleans
Parish LA was added in 0.6.13; 0.6.15 makes `attributeSearch` honoured by the
capability readers `offersAttributeSearch` and `countyOffersAttributeSearch`
and exports `canonicalLayerUrl`. No code changes. The counts in `README.md`,
`package.json` and `server.json` were already 246 / 258.

## 0.2.8 — 2026-10-04

Dependency catch-up to atlas 0.6.14 (239 → 246 counties, 251 → 258
endpoints): Mille Lacs County MN (owner search on TAXPAYER_NAME) and St. Louis
city MO (an independent city, distinct from St. Louis County; the first atlas
record with `corsEnabled: false`, so it is server-side only, which this server
is) from 0.6.12. Atlas 0.6.13 (Orleans Parish LA, location queries only,
attribute search unsupported) and 0.6.14 (Essex NJ, Clackamas OR, Phelps NE,
Tulare CA, Sullivan TN; Garfield OK on record without an endpoint) are both
included. No code changes. `README.md`, `package.json`'s `description` and
`server.json`'s `description` carry the new counts.

## 0.2.7 — 2026-10-04

Search policy follows the atlas's own capability data, and the dependency
moves to atlas 0.6.11 (235 → 239 counties, 247 → 251 endpoints: Dougherty GA,
Mobile AL, Malheur OR and Island WA added in 0.6.10; 0.6.11 repairs Monmouth
NJ, Prince George's MD and Pinal AZ, fixes Arkansas's zero-row scopes and
Washoe NV's field order). `README.md`, `package.json`'s `description` and
`server.json`'s `description` carry the new counts.

- Owner queries on shared layers now lead with `(scopeWhere) AND`, in both the
  URL and the printed WHERE clause; a `Scope:` line appears in `find_county`,
  `get_parcel_endpoint` and `build_owner_query`. The whole WHERE is
  %-encoded (before, only the name was).
- The 67 Florida FDOR layers are refused for attribute search with a
  location-query hint; 56 FL counties now read "location queries only" in
  `list_counties`.
- Owner columns a county marks `searchable: false` are refused: Orleans Parish
  LA loses its owner query and reads "APN only (owner column not searchable)";
  the Owner line says "not searchable by name (column exists; use a parcel-id
  or location query)".
- The owner-column test is now the UKS site classifier on field name + label
  with the address/locale exclude: 26 counties gain an owner query (al-shelby,
  de-new-castle, fl-sarasota, fl-lee, fl-pasco, il-dupage, in-hamilton,
  ks-shawnee, mi-lenawee, ms-hinds, nv-washoe, nc-forsyth, nc-guilford,
  nc-cumberland, nd-cass, oh-hamilton, oh-mahoning, ok-oklahoma, or-multnomah,
  or-umatilla, pa-montgomery and others), none lose one; ia-johnson and
  tx-williamson move to the column the site already picks.
- `list_counties` has two new coverage labels: "location queries only" and
  "APN only (owner column not searchable)"; the README has the label table.
- Tool descriptions for `build_owner_query` and `get_parcel_endpoint` describe
  the scope prefix and the three refusal kinds.
- New `test:policy` suite (12) and CI step; `prepublishOnly` runs smoke +
  policy.

## 0.2.6 — 2026-09-26

Catch-up to atlas 0.6.9: 227 → 235 counties, 241 → 247 endpoints, across a
`totals.states` count that moves from 50 to 51 because 0.6.9 adds the
District of Columbia as its own entry (1 county, 1 endpoint) in atlas's
`states` array. `README.md`, `package.json`'s `description` and
`server.json`'s `description` are rewritten to these numbers, phrased as
"51 US states (50 states plus DC)" so the digit `verify-package.mjs` reads
immediately before "US states" is 51 — the raw `totals.states` value —
without the text itself claiming DC is a 51st state rather than the 51st
entry.

- **`dependencies["@urbankitstudio/atlas"]` raised from `^0.6.5` to `^0.6.9`.**
  Unlike the 0.2.4 catch-up, atlas 0.6.9 was already on npm at publish time,
  so there is no ordering hazard in raising the floor to match it directly.
- **Coverage wording moved from "layers" to "endpoints"** in both manifest
  descriptions and the README's intro line, to match the field name atlas's
  own `data/index.json` uses (`totals.endpoints`) and the wording atlas's own
  README and npm description already use ("247 verified endpoints"). The
  README's Coverage line already said "endpoints"; only the intro line and
  the two manifest descriptions said "layers". `verify-package.mjs`'s regex
  accepts either word, so this is a consistency choice, not a compliance fix.
- **What atlas 0.6.6 through 0.6.9 actually changed**, reconstructed from
  `npm view @urbankitstudio/atlas@<version> description` for each version in
  turn, since the published atlas package carries no `CHANGELOG.md` of its
  own:
  - 0.6.6 — no change in the advertised counts (227 counties / 241
    endpoints); nothing here shows what changed.
  - 0.6.7 — 227 → 233 counties, 241 → 245 endpoints.
  - 0.6.8 — 233 → 234 counties, 245 → 246 endpoints.
  - 0.6.9 — 234 → 235 counties, 246 → 247 endpoints, and the description
    text itself changes from "all 50 US states" to "all 50 US states and
    DC" — this is the DC release.
- **Why this release exists**: a `npx -y @urbankitstudio/mcp-atlas` stdio
  user's tooling keeps reusing its cached install, atlas included, for as
  long as this package's own published version does not change — regardless
  of how far `@urbankitstudio/atlas` itself has moved on npm in the meantime.
  `npm run test:currency` (`scripts/check-atlas-currency.mjs`) is the one
  gate that looks outward at npm rather than at this repo, and it was red
  going into this release: package-lock.json pinned atlas 0.6.5 while npm
  already served 0.6.9. This version bump, dependency bump and lockfile
  update are what turn it green again.

## 0.2.5 — 2026-09-21

No code change. `server.ts` and the four tool schemas are byte-identical to
0.2.4; this release exists to exercise two publishing changes that cannot be
verified any other way.

- **Publishing is now bound to a GitHub Environment.** The npm Trusted Publisher
  entry names the environment `npm-publish`, which is restricted to `main`. npm
  checks the OIDC token for an `environment` claim carrying that name, and
  GitHub only mints that claim when the job itself declares the environment —
  so `publish.yml` now does. The two halves have to land together: npm was
  configured to expect the claim before the workflow emitted it, which left
  publishing broken in between. This release proves the pair works.
- **README**: the Socket score badge moved above the title and onto its own
  line. npm only refreshes a package's README on publish, so a README-only
  change is invisible on npmjs.com until a version ships.

0.2.4 was the first release published from this repository rather than the
private monorepo, over OIDC and with provenance. 0.2.5 is the first published
under the environment restriction as well.

## 0.2.4 — 2026-09-20

No code change; `server.ts` and the four tool schemas are unchanged. This
package bundles no data of its own — it calls into `@urbankitstudio/atlas` at
runtime — so there is nothing here for Florida's county growth to touch
directly.

- **Catch-up to atlas 0.6.5**: 171 → 227 counties across all 50 states, 174 →
  241 verified endpoints. Florida alone grew from 11 to 67 counties. The
  `description` and `README.md` county counts were already updated to
  227/241 on `main` as part of the data change that added Florida
  (urbankitstudio#759); this release is the version bump and republish that
  actually ships that text and the atlas dependency's now-current data to
  installs, since editing a manifest on `main` doesn't reach anyone who
  already `npm install`ed. README's `(atlas 0.6.2)` freshness note is
  corrected to `(atlas 0.6.5)` — those 227/241 numbers were never true of the
  real atlas 0.6.2 (which shipped 171/174; see `packages/atlas/CHANGELOG.md`).
- **`dependencies["@urbankitstudio/atlas"]` floor deliberately left at
  `^0.6.2`, not raised to `^0.6.5`.** Every prior "catch-up" release raised
  the floor to the atlas version it was verified against, but each of those
  atlas versions was already on npm at publish time. This release is prepared
  in the same change as the atlas 0.6.5 bump, before it is published — so a
  floor of `^0.6.5` would make `npm install` in this package unresolvable
  (no matching version) until atlas 0.6.5 actually lands on the registry, in
  whichever order the two publishes happen. `^0.6.2` already resolves to the
  newest published 0.6.x for a fresh install, atlas 0.6.4 today and 0.6.5 once
  it ships, with no further mcp-atlas release required — the same "reaches
  everyone already installed" property the atlas package's own README
  documents for its patch releases.

## 0.2.3 — 2026-09-20

No code change. The package manifest gains the `mcpName` field
(`io.github.LEOyrh/mcp-atlas`) that the official MCP registry reads from the
published npm package to prove the publisher owns it. 0.1.5 carried it, the
monorepo's manifest never did, and every publish since (0.1.6 through 0.2.2)
went out without it, so the registry refused to list any of them: it still
served 0.1.5 with the old repository URL until this release. The publish
workflow now refuses a manifest without the field, and CI pins it to
`server.json`'s name.

## 0.2.2 — 2026-09-18

Tool descriptions rewritten, plus one security fix. The same four tools take the
same parameters and return the same shape of payload.

- **An owner name can no longer escape the SQL string literal.**
  `build_owner_query` put the caller's text into an ArcGIS `where` clause behind
  nothing but `encodeURIComponent`, which is not an escape here: `'` and `)` are
  both in its unreserved set, so `A') OR 1=1 --` passed through intact and
  arrived at a county's server as a well-formed predicate with the tail
  commented out. The same payload was rendered unencoded in the `WHERE clause:`
  line users are invited to copy. Single quotes are now doubled, the
  SQL-standard escape, in both outputs. Nothing in this package was at risk: it
  executes no query, stores no data and holds no credentials. The endpoints the
  query names are third-party government servers, and the realistic route was
  indirect prompt injection steering a client into making the call.

- **Each tool description now says when to use it and which tool to use
  instead.** Glama's tool-definition scan scored disambiguation 2 out of 5:
  "find_county and get_parcel_endpoint overlap heavily: both return endpoint
  URLs, searchable fields, owner fields, and sample query URLs. list_counties
  and find_county also both identify counties, so the tool boundaries are not
  clearly distinct." That reading was correct. The two do return the same
  per-county record, and nothing in either description told an agent how to
  choose. What actually separates them is how precisely the caller can already
  name the county, and none of the four descriptions said so.
- `find_county` is now described by what only it does: resolve an uncertain,
  misspelled or FIPS-coded reference, and name every county it matched rather
  than guess one. `get_parcel_endpoint` is the exact-pair lookup and says to
  call `find_county` first when the name is uncertain. `list_counties` says it
  deliberately returns no URLs. `build_owner_query` says it is the only tool
  that searches for a named owner, and that this server never executes a query.
- README gains a four-row table for choosing a tool, and states the overlap
  outright instead of leaving a reader to find it.

## 0.2.1 — 2026-09-03

Metadata only. No behaviour change. The package author, the license holder
and the README credit now name UrbanKit Studio instead of an individual.

## 0.2.0 — 2026-09-02

- **Owner lookups say so before the request when a county publishes no owner
  name** (#540). `ownerFieldFrom()` decided a county had owners by matching
  the column name alone, so for the fourteen counties whose owner column
  exists and is empty, `list_counties` said "owner+APN", `find_county` and
  `get_parcel_endpoint` printed the field as usable, and `build_owner_query`
  returned a query that finds zero rows. Every one of those paths now asks
  the reviewed capability record first and prints, for Oakland County MI for
  example, "OWNER NAME NOT AVAILABLE … NAME1 and NAME2 … carry no value in
  any record sampled". The smoke fixture moves from Wake County NC to
  Oakland: Wake's advisory came from an audit predicate that compared
  against NULL and was reverted before atlas 0.6.1 (Wake publishes owner
  names on 437,715 rows).
- **Catch-up to atlas 0.6.2**: 171 counties across all 50 states, 174
  verified endpoints. Oregon's Multnomah entry no longer points at Umatilla
  County's tax lots (that layer now has its own Umatilla County entry), and
  Lane's entry records its 2026-09-01 outage.
- `@urbankitstudio/atlas` dependency `^0.5.1` → `^0.6.2`. A caret on a 0.x
  version pins the minor, so every 0.1.6 install kept resolving atlas 0.5.x
  (155 counties) however far the atlas moved; this is the release that moves
  the MCP server with it.
- `description` and `README.md` county counts 155 → 171.

## 0.1.6 — 2026-08-06

Published from this monorepo through the publish path #370 added (npm
`gitHead` aab7346). Dependencies at publish: `@modelcontextprotocol/sdk@^1.30.0`,
`@urbankitstudio/atlas@^0.5.1`. The two changes below had been sitting under
"Unreleased" since the 2026-07-20 reconciliation and shipped with it.

- `list_counties` tool description now interpolates `atlas.totals.counties`
  instead of a hardcoded count string, so it can't silently go stale again
  the next time the atlas grows past 155 counties.
- `dependencies["@urbankitstudio/atlas"]` floor raised to `^0.5.1` to make
  explicit that this copy is verified against the King County / Will County
  data patch (was `^0.5.0` in the last publish, itself already stale at
  `^0.4.0` in this monorepo's pre-reconciliation `package.json`).

## 0.1.5 — 2026-07-03

Published from the standalone `github.com/LEOyrh/mcp-atlas` repo (see the
0.1.2 entry below — this monorepo's `packages/mcp-atlas/` was not the source
for this or any of the 0.1.2–0.1.5 publishes).

- Catch-up to the atlas 0.5.0 resync (128 → 155 counties, all 50 states
  populated): `description` and `README.md` reworded, county-count mentions
  137 → 155, `@urbankitstudio/atlas` dependency `^0.4.0` → `^0.5.0`.

## 0.1.4 — 2026-06-21

- `mcpName` casing fix: `io.github.leoyrh/mcp-atlas` →
  `io.github.LEOyrh/mcp-atlas`. MCP registry namespace verification is
  case-sensitive against the GitHub account name; the 0.1.3 value would not
  have verified.

## 0.1.3 — 2026-06-21

- Added `mcpName: "io.github.leoyrh/mcp-atlas"` for MCP registry namespace
  ownership verification (corrected the next day — see 0.1.4).

## 0.1.2 — 2026-06-20

- `repository` field repointed from this monorepo (`LEOyrh/urbankitstudio`,
  directory `packages/mcp-atlas`) to the standalone `LEOyrh/mcp-atlas` repo.
  All publishes from this point through 0.1.5 shipped from that standalone
  repo, not this monorepo copy — the reason `packages/mcp-atlas/` here fell
  behind (see the 2026-07-20 reconciliation note below).

## 0.1.1 — 2026-06-20

- `bin.mcp-atlas` path fixed: `./dist/server.js` → `dist/server.js` (dropped
  the leading `./`, which some `npx`/global-bin resolution paths mishandled).

## 0.1.0 — 2026-06-20

- Initial public release. Four tools: `list_counties`, `find_county`,
  `get_parcel_endpoint`, `build_owner_query`.

---

## Repo reconciliation — 2026-07-20

`packages/mcp-atlas/package.json` in this monorepo had been stuck at 0.1.1
(the last version actually published from here) while npm's `latest` had
moved to 0.1.5, published from the standalone repo described in the 0.1.2
entry above. Reconciled this copy to match what is live:

- `version`: `0.1.1` → `0.1.5`.
- `description` / `README.md`: "137 verified... " / "128+ counties across 39
  US states" → "155 verified..." / "155 counties across all 50 US states",
  matching what 0.1.5 already shipped.
- `dependencies["@urbankitstudio/atlas"]`: `^0.4.0` → `^0.5.1` (0.1.5 shipped
  with `^0.5.0`; this floor is raised further to the atlas patch published
  alongside this reconciliation — see `packages/atlas/CHANGELOG.md` 0.5.1).

No new npm publish is required for this reconciliation by itself. Publish a
new `mcp-atlas` version only if the `Unreleased` section above (the dynamic
county-count string) is worth shipping on its own, or if a future change
needs one.
