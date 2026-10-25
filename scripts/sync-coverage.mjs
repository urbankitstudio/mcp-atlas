/**
 * The coverage numbers this package advertises, derived from the installed
 * @urbankitstudio/atlas rather than typed by hand.
 *
 * Every atlas release that moves its totals used to mean editing four
 * sentences by hand (README twice, the package.json description, the
 * server.json description), and verify-package.mjs only finds out at pack
 * time that one was missed. This script writes them from the atlas itself:
 * `totals` in data/index.json, the endpoint statuses for "N of them live", and
 * the package.json range floor for "(atlas x.y.z)", which verify-package.mjs
 * requires to equal the README's.
 *
 * Each claim is matched by a pattern that must hit EXACTLY the expected number
 * of times. A reworded sentence that no longer matches is an error, never a
 * claim quietly left alone.
 *
 * Usage:  node scripts/sync-coverage.mjs           rewrite the claims in place
 *         node scripts/sync-coverage.mjs --check   exit 1 if any claim is stale
 * test/coverage-claims.test.mjs runs the check in `npm run test:policy`.
 */
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atlas } from "@urbankitstudio/atlas";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The numbers, read from the installed atlas and package.json. */
export function coverageFacts(root = ROOT) {
  const index = JSON.parse(
    readFileSync(join(root, "node_modules", "@urbankitstudio", "atlas", "data", "index.json"), "utf8"),
  );
  const t = index.totals ?? {};
  for (const key of ["states", "counties", "endpoints", "countiesWithEndpoint"]) {
    if (!Number.isInteger(t[key])) throw new Error(`atlas totals.${key} is not an integer (got ${JSON.stringify(t[key])})`);
  }
  let live = 0;
  for (const state of atlas.byStateSlug.values()) {
    for (const c of state.counties) for (const ep of c.endpoints) if (ep.status === "live") live++;
  }
  const range = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies?.["@urbankitstudio/atlas"];
  const floor = typeof range === "string" ? range.match(/(\d+\.\d+\.\d+)/)?.[1] : undefined;
  if (!floor) throw new Error(`package.json declares no readable @urbankitstudio/atlas range (got ${JSON.stringify(range)})`);
  return {
    states: t.states,
    counties: t.counties,
    endpoints: t.endpoints,
    live,
    withEndpoint: t.countiesWithEndpoint,
    without: t.counties - t.countiesWithEndpoint,
    floor,
  };
}

/** Where each claim lives, the pattern that finds it, and what it must say. */
export const SITES = [
  {
    file: "README.md",
    re: /of \d+ counties across \d+ US states \(50 states plus DC\), \d+ endpoints total/g,
    text: (f) => `of ${f.counties} counties across ${f.states} US states (50 states plus DC), ${f.endpoints} endpoints total`,
  },
  {
    file: "README.md",
    re: /\*\*Coverage:\*\* \d+ counties across \d+ US states \(50 states plus DC\), \d+ endpoints, \d+ of them live \(atlas \d+\.\d+\.\d+\)\. \d+ of the counties have an endpoint; for the other \d+ the atlas/g,
    text: (f) =>
      `**Coverage:** ${f.counties} counties across ${f.states} US states (50 states plus DC), ${f.endpoints} endpoints, ${f.live} of them live (atlas ${f.floor}). ${f.withEndpoint} of the counties have an endpoint; for the other ${f.without} the atlas`,
  },
  {
    file: "package.json",
    re: /of \d+ counties across \d+ US states \(50 states plus DC\), \d+ endpoints total/g,
    text: (f) => `of ${f.counties} counties across ${f.states} US states (50 states plus DC), ${f.endpoints} endpoints total`,
  },
  {
    file: "server.json",
    re: /across \d+ US counties \(\d+ ArcGIS endpoints\)/g,
    text: (f) => `across ${f.counties} US counties (${f.endpoints} ArcGIS endpoints)`,
  },
];

/** Rewrites one site's claim in `source`. Throws unless the pattern hits exactly once. */
export function rewriteSite(source, site, facts) {
  const hits = source.match(site.re) ?? [];
  if (hits.length !== 1) {
    throw new Error(`${site.file}: expected exactly 1 coverage claim matching ${site.re}, found ${hits.length}. Reworded? Update SITES in scripts/sync-coverage.mjs.`);
  }
  return source.replace(site.re, site.text(facts));
}

/** Every file's current text and the text it should have. */
export function coverageEdits(root = ROOT) {
  const facts = coverageFacts(root);
  const files = [...new Set(SITES.map((s) => s.file))];
  return files.map((file) => {
    const before = readFileSync(join(root, file), "utf8");
    const after = SITES.filter((s) => s.file === file).reduce((text, site) => rewriteSite(text, site, facts), before);
    return { file, before, after };
  });
}

export function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  const stale = coverageEdits().filter((e) => e.before !== e.after);
  if (check) {
    for (const e of stale) console.error(`stale coverage claim in ${e.file}: run node scripts/sync-coverage.mjs`);
    if (stale.length === 0) console.log("coverage claims agree with the installed atlas");
    return stale.length === 0 ? 0 : 1;
  }
  for (const e of stale) {
    writeFileSync(join(ROOT, e.file), e.after);
    console.log(`rewrote ${e.file}`);
  }
  if (stale.length === 0) console.log("coverage claims already agree with the installed atlas");
  return 0;
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
