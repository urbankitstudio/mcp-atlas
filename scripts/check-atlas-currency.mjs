/**
 * Has this server followed the newest @urbankitstudio/atlas on npm?
 *
 * Leo's agent-first order (2026-09-26): whenever the atlas ships counties,
 * tools or fixes, the npm and MCP packages are updated FIRST. This server is
 * one of them, and the atlas is its runtime dependency. Nothing in this repo
 * can see when it falls behind, because the fact lives on npm, so no hermetic
 * test can catch it. This script is the one check that looks outward. It runs
 * on a schedule from .github/workflows/atlas-currency.yml.
 *
 * WHICH VERSION IT COMPARES, AND WHY THE LOCKFILE.
 *   - An end user never sees package-lock.json. The tarball ships none, so
 *     `npx -y @urbankitstudio/mcp-atlas` resolves the published RANGE, and npm
 *     takes the `latest` tag whenever the range admits it. A returning npx user
 *     is different: npx reuses its cached tree, atlas included, for as long as
 *     THIS package's latest version is unchanged.
 *   - Everything this repo verifies runs against the LOCKFILE: `npm ci` in
 *     ci.yml and publish.yml, the stdio smoke test, and the coverage parity in
 *     verify-package.mjs that keeps the advertised county counts honest.
 *   So a lockfile behind npm always means this server owes a release. If the
 *   range admits the new atlas, fresh installs already run it untested here,
 *   while returning users never get it. If the range does not admit it, nobody
 *   gets it. A check on the range alone would miss the first case, which is the
 *   drift #9 found: CI testing a smaller atlas than users install.
 *
 * Verdicts, reported through process.exitCode:
 *   current  npm latest = the lockfile          0
 *   behind   npm latest > the lockfile          1, with the remedy
 *   ahead    npm latest < the lockfile          1: an unpublish, or a moved dist-tag
 *   unknown  a version could not be read        1: "could not ask" is not "current"
 *
 * Run locally: node scripts/check-atlas-currency.mjs
 */
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ATLAS = "@urbankitstudio/atlas";
export const REGISTRY_URL = "https://registry.npmjs.org/@urbankitstudio%2Fatlas/latest";
const TIMEOUT_MS = 15_000;
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * [major, minor, patch] for a plain `x.y.z`, else null. Prereleases are not
 * compared: the atlas has never published one, and guessing their order would
 * be worse than reporting them as unreadable.
 */
export function parseVersion(text) {
  const m = typeof text === "string" ? /^(\d+)\.(\d+)\.(\d+)$/.exec(text) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Negative when a is older than b, 0 when equal, positive when newer. Numeric,
 * never lexical: as strings, "0.6.10" sorts before "0.6.9".
 */
export function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  if (!x || !y) throw new TypeError(`not a plain x.y.z version: ${JSON.stringify(x ? b : a)}`);
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Whether package.json's `range` admits `version`: true, false, or null when
 * the range is not ^x.y.z, ~x.y.z or x.y.z. A null is reported as "cannot
 * say", never guessed.
 */
export function rangeAdmits(range, version) {
  const m = /^([\^~]?)(\d+\.\d+\.\d+)$/.exec(typeof range === "string" ? range.trim() : "");
  if (!m || !parseVersion(version)) return null;
  const [, op, floor] = m;
  if (compareVersions(version, floor) < 0) return false;
  if (op === "") return compareVersions(version, floor) === 0;
  // The first version the range excludes. A caret holds the left-most
  // non-zero part fixed, so ^0.6.5 stops below 0.7.0.
  const [a, b, c] = parseVersion(floor);
  const ceiling = op === "~" ? [a, b + 1, 0] : a > 0 ? [a + 1, 0, 0] : b > 0 ? [0, b + 1, 0] : [0, 0, c + 1];
  return compareVersions(version, ceiling.join(".")) < 0;
}

/**
 * The whole decision, with no I/O, so every verdict is testable offline.
 * `latest` is npm's answer; `fetchError` and `readError` say why one is missing.
 */
export function judge({ locked, range, latest, fetchError, readError }) {
  const facts = `npm latest ${latest ?? "(not read)"}; package-lock.json ${locked ?? "(none)"}; package.json range ${range ?? "(none)"}`;
  const unknown = (why) => ({
    verdict: "unknown",
    exitCode: 1,
    lines: [`::error title=atlas currency not checked::${why} This is not "current": the comparison did not run.`, facts],
  });

  if (readError) return unknown(`Could not read package.json or package-lock.json: ${readError}.`);
  if (!parseVersion(locked)) {
    return unknown(`package-lock.json pins no plain x.y.z version of ${ATLAS} (read ${JSON.stringify(locked)}).`);
  }
  if (fetchError) return unknown(`Could not ask npm for the latest ${ATLAS}: ${fetchError}.`);
  if (!parseVersion(latest)) {
    return unknown(`npm answered with a latest version this check cannot compare (${JSON.stringify(latest)}).`);
  }

  const order = compareVersions(latest, locked);
  if (order === 0) {
    return { verdict: "current", exitCode: 0, lines: [`ok  ${ATLAS} is current. ${facts}`] };
  }
  if (order < 0) {
    return {
      verdict: "ahead",
      exitCode: 1,
      lines: [
        `::error title=npm is behind this lockfile::npm's latest ${ATLAS} is ${latest}, older than the ${locked} that package-lock.json pins. That happens only when a version was unpublished or the latest dist-tag was moved back. Find out which before the next release: if ${locked} was pulled for a defect, this server is built on it.`,
        facts,
      ],
    };
  }

  const admits = rangeAdmits(range, latest);
  const reach =
    admits === true
      ? `Who has it: package.json's range ${range} admits ${latest}, so a fresh npx install already runs it, untested here and with coverage claims measured on ${locked}. A returning npx user keeps the atlas their cached tree first resolved, for as long as this package's latest version is unchanged.`
      : admits === false
        ? `Who has it: nobody through this server. package.json's range ${range} stops below ${latest}, so agents stay on the older atlas until this server re-releases.`
        : `Who has it: unknown. package.json's range ${JSON.stringify(range)} is not ^x.y.z, ~x.y.z or x.y.z, so this check cannot say whether installs resolve ${latest}.`;
  return {
    verdict: "behind",
    exitCode: 1,
    lines: [
      `::error title=mcp-atlas has not followed the atlas::npm serves ${ATLAS} ${latest} but package-lock.json pins ${locked}. Remedy: bump ${ATLAS} to ${latest} in package.json and the lockfile with a repo-local install (npm install ${ATLAS}@${latest}, never -g); run npm run typecheck, build and smoke; update the coverage claims verify-package.mjs checks (the README's counts and its "(atlas x.y.z)", the package.json description, server.json's description); bump this package's version, CHANGELOG.md and both version fields of server.json; release by merging to main.`,
      reach,
      facts,
    ],
  };
}

/** The atlas version package-lock.json pins and the range package.json declares. */
export function readPins(repoDir = ROOT) {
  const lock = JSON.parse(readFileSync(resolve(repoDir, "package-lock.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(resolve(repoDir, "package.json"), "utf8"));
  return { locked: lock.packages?.[`node_modules/${ATLAS}`]?.version, range: pkg.dependencies?.[ATLAS] };
}

/** npm's latest atlas as `{ latest }`, or `{ error }` saying why it could not be read. */
export async function fetchLatest(fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(REGISTRY_URL, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) return { error: `${REGISTRY_URL} answered HTTP ${res.status} ${res.statusText}` };
    const body = await res.json();
    if (typeof body?.version !== "string") return { error: `${REGISTRY_URL} returned no version field` };
    return { latest: body.version };
  } catch (err) {
    if (controller.signal.aborted) return { error: `no answer from ${REGISTRY_URL} within ${timeoutMs / 1000}s` };
    const cause = err?.cause ? ` (${err.cause.code ?? err.cause.message})` : "";
    return { error: `${REGISTRY_URL} failed: ${err?.message ?? err}${cause}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function main({ repoDir = ROOT, fetchImpl = globalThis.fetch, log = console.log } = {}) {
  let pins;
  try {
    pins = readPins(repoDir);
  } catch (err) {
    pins = { readError: err.message };
  }
  const answer = pins.readError ? {} : await fetchLatest(fetchImpl);
  const result = judge({ ...pins, latest: answer.latest, fetchError: answer.error });
  for (const line of result.lines) log(line);
  return result;
}

// Only when run as a script. Importing this file, as the tests do, runs nothing.
const entry = process.argv[1];
if (entry && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = (await main()).exitCode;
}
