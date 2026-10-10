# CLAUDE.md: urbankitstudio/mcp-atlas

Rules for any Claude session working in this repository. Keep this file under 80 lines.

## What this is

`@urbankitstudio/mcp-atlas` is a stdio MCP server with four tools (`list_counties`,
`find_county`, `get_parcel_endpoint`, `build_owner_query`). It answers from
`@urbankitstudio/atlas`, UrbanKit Studio's registry of verified county parcel ArcGIS
endpoints, and bundles no data of its own: the atlas is a runtime dependency. No lockfile
ships in the tarball, so an install resolves the published range fresh. It publishes to npm
and is listed on the MCP registry as `io.github.urbankitstudio/mcp-atlas` (`server.json`), which
publish.yml updates on every release over GitHub OIDC. Until 0.2.20 the name was
`io.github.LEOyrh/mcp-atlas`, published by hand; that entry is deprecated.

## What it follows

- The atlas is authored in the UKS repo (`urbankitstudio/urbankitstudio`, `packages/atlas`),
  mirrored to `urbankitstudio/atlas`, and published from there. When the atlas releases,
  this server follows with a dependency bump and a release of its own.
- The UKS site advertises this package's version, and its `advertised-version-drift.yml`
  compares that against npm daily, so a release here turns that check red until the site
  catches up.

## Agent-first (Leo, 2026-09-26)

Every feature, tool, county or fix reaches AI agents first: the npm data package, this
stdio server and the hosted MCP ship before the paid meter and tiers, and the site's
free-tools UI comes last. For this repo, an atlas release is not finished until this server
has followed it.

## Release checklist (following an atlas release)

1. `npm install @urbankitstudio/atlas@<version>` in this repo. It moves the package.json
   range floor and the lockfile together. Never `-g`, and never a global install.
2. `npm run typecheck`, `npm run build`, `npm run smoke`, `npm run test:currency`.
3. Match the coverage claims to the new atlas totals: README.md's coverage sentence and its
   `(atlas x.y.z)`, which must equal the range floor; the package.json `description`; and
   `server.json`'s `description`, capped at 100 characters. `scripts/verify-package.mjs`
   refuses any mismatch.
4. Bump the version in package.json and in both version fields of server.json (`version`,
   `packages[0].version`), and add a CHANGELOG.md entry.
5. Release by merging to main with the version change. `publish.yml` publishes over OIDC
   under the `npm-publish` environment, which admits main only. A green run is not a
   publish: confirm with `npm view @urbankitstudio/mcp-atlas version`.

## Gates

- `ci.yml` runs on every PR and push to main: install from the lockfile, typecheck, build,
  server.json consistency and schema caps, stdio smoke, and `verify-package.mjs` against the
  packed tarball.
- `publish.yml` runs on a version change on main: the same gates, then the publish.
- `atlas-currency.yml` runs daily at 07:10 UTC and on dispatch. Red means npm serves a newer
  atlas than package-lock.json pins, so this server owes the checklist above. It stays off
  push and PR triggers because it needs the network, and a flake must never become a
  required check.

## Standing rules

- No `npm -g` or any other global or machine-wide install. Missing tooling is a blocker to
  report, not something to fix.
- `pull_request` workflows stay on GitHub-hosted runners, never a self-hosted one.
- Nothing under `.env` is read, printed or committed. This repo holds no npm token.
- Never `npm publish` by hand, and never rename `publish.yml`: npm's Trusted Publisher entry
  matches that filename, and provenance comes only from the OIDC publish.
