/**
 * Tests for scripts/check-atlas-currency.mjs and the workflow that runs it.
 *
 * Hermetic: nothing here reaches npm. The comparison is tested as a pure
 * function, and the script's own entry point runs in a child process whose
 * fetch is replaced before the script loads.
 *
 * Usage:  node --test test/atlas-currency.test.mjs
 * Or via: npm run test:currency
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = "scripts/check-atlas-currency.mjs";
const WORKFLOW = resolve(ROOT, ".github/workflows/atlas-currency.yml");

// fetch is replaced BEFORE the checker loads. If importing it ever starts the
// check, the first test sees the call instead of the suite reaching npm.
let fetchCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => {
  fetchCalls += 1;
  throw new Error("this suite never reaches the network");
};
const { judge, compareVersions, rangeAdmits, fetchLatest, REGISTRY_URL } = await import(`../${SCRIPT_PATH}`);
const fetchCallsDuringImport = fetchCalls;
globalThis.fetch = realFetch;

test("importing the checker runs no check", () => {
  assert.equal(fetchCallsDuringImport, 0, "importing the checker called fetch: its entry guard is broken");
});

// ---------------------------------------------------------------------------
// The four verdicts
// ---------------------------------------------------------------------------

test("behind: npm newer than the lockfile is an error that carries the remedy", () => {
  const r = judge({ locked: "0.6.5", range: "^0.6.5", latest: "0.6.8" });
  assert.equal(r.verdict, "behind");
  assert.equal(r.exitCode, 1);
  assert.match(r.lines[0], /^::error /);
  assert.match(r.lines[0], /npm install @urbankitstudio\/atlas@0\.6\.8/);
  assert.match(r.lines[0], /server\.json/);
  assert.match(r.lines[0], /CHANGELOG/);
  assert.match(r.lines.join("\n"), /admits 0\.6\.8/);
});

test("current: npm equal to the lockfile passes and prints both", () => {
  const r = judge({ locked: "0.6.8", range: "^0.6.5", latest: "0.6.8" });
  assert.equal(r.verdict, "current");
  assert.equal(r.exitCode, 0);
  const out = r.lines.join("\n");
  assert.doesNotMatch(out, /::error/);
  assert.match(out, /npm latest 0\.6\.8/);
  assert.match(out, /package-lock\.json 0\.6\.8/);
});

test("ahead: npm older than the lockfile is an error that names the unpublish", () => {
  const r = judge({ locked: "0.6.9", range: "^0.6.5", latest: "0.6.8" });
  assert.equal(r.verdict, "ahead");
  assert.equal(r.exitCode, 1);
  assert.match(r.lines[0], /^::error /);
  assert.match(r.lines[0], /unpublished/);
});

test("could not ask npm: an error with its own message, never 'current'", () => {
  const r = judge({ locked: "0.6.5", range: "^0.6.5", fetchError: "no answer within 15s" });
  assert.equal(r.verdict, "unknown");
  assert.equal(r.exitCode, 1);
  assert.match(r.lines[0], /^::error title=atlas currency not checked::/);
  assert.match(r.lines[0], /Could not ask npm/);
  assert.match(r.lines[0], /no answer within 15s/);
});

// ---------------------------------------------------------------------------
// What the verdicts rest on
// ---------------------------------------------------------------------------

test("versions compare as numbers: 0.6.10 is newer than 0.6.9", () => {
  assert.ok(compareVersions("0.6.10", "0.6.9") > 0);
  assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
  assert.ok(compareVersions("1.0.0", "0.99.99") > 0);
  assert.equal(compareVersions("0.6.8", "0.6.8"), 0);
  assert.equal(judge({ locked: "0.6.9", range: "^0.6.9", latest: "0.6.10" }).verdict, "behind");
});

test("a lag outside the range says nobody gets the new atlas", () => {
  const r = judge({ locked: "0.6.8", range: "^0.6.5", latest: "0.7.0" });
  assert.equal(r.verdict, "behind");
  assert.match(r.lines.join("\n"), /stops below 0\.7\.0/);

  assert.equal(rangeAdmits("^0.6.5", "0.6.8"), true);
  assert.equal(rangeAdmits("^0.6.5", "0.7.0"), false);
  assert.equal(rangeAdmits("^0.6.5", "0.6.4"), false);
  assert.equal(rangeAdmits("^1.2.3", "1.9.0"), true);
  assert.equal(rangeAdmits("^1.2.3", "2.0.0"), false);
  assert.equal(rangeAdmits("^0.0.3", "0.0.4"), false);
  assert.equal(rangeAdmits("~0.6.5", "0.6.9"), true);
  assert.equal(rangeAdmits("~0.6.5", "0.7.0"), false);
  assert.equal(rangeAdmits("0.6.5", "0.6.8"), false);
  assert.equal(rangeAdmits(">=0.6.5", "0.6.8"), null);
});

test("an unreadable version is 'unknown', not a comparison", () => {
  assert.equal(judge({ locked: undefined, range: "^0.6.5", latest: "0.6.8" }).verdict, "unknown");
  assert.equal(judge({ locked: "0.6.5", range: "^0.6.5", latest: "1.0.0-rc.1" }).verdict, "unknown");
  assert.equal(judge({ readError: "ENOENT" }).verdict, "unknown");
});

test("fetchLatest: a registry that never answers times out as an error, and so does an HTTP error", async () => {
  let seen;
  const silent = (url, init) => {
    seen = { url, init };
    return new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  };
  const timedOut = await fetchLatest(silent, 50);
  assert.equal(seen.url, REGISTRY_URL);
  assert.match(seen.init.headers["user-agent"], /^Mozilla\/5\.0 /);
  assert.equal(timedOut.latest, undefined);
  assert.match(timedOut.error, /within 0\.05s/);

  const refused = await fetchLatest(async () => ({ ok: false, status: 503, statusText: "Service Unavailable" }));
  assert.equal(refused.latest, undefined);
  assert.match(refused.error, /HTTP 503/);
});

// ---------------------------------------------------------------------------
// The wiring: the script as the workflow runs it
// ---------------------------------------------------------------------------

/** Run the script exactly as the workflow does, with npm's answer replaced. */
function runScript(registryVersion) {
  const stub = `globalThis.fetch = async () => ({ ok: true, status: 200, statusText: "OK", json: async () => ({ version: ${JSON.stringify(registryVersion)} }) });`;
  return spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(stub)}`, SCRIPT_PATH], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

test("run as a script: exit 1 when npm is ahead of the lockfile, exit 0 when equal", () => {
  const lock = JSON.parse(readFileSync(resolve(ROOT, "package-lock.json"), "utf8"));
  const locked = lock.packages["node_modules/@urbankitstudio/atlas"].version;

  const lag = runScript("999.0.0");
  assert.equal(lag.status, 1, lag.stdout + lag.stderr);
  assert.match(lag.stdout, /::error title=mcp-atlas has not followed the atlas::/);
  assert.ok(lag.stdout.includes(`package-lock.json pins ${locked}`), lag.stdout);

  const same = runScript(locked);
  assert.equal(same.status, 0, same.stdout + same.stderr);
  assert.match(same.stdout, /is current/);
});

// ---------------------------------------------------------------------------
// The workflow's shape. No YAML parser is installed here, so these are string
// assertions on the file with its comments removed: the header talks about
// `push` and names the script, and prose must not satisfy an assertion about
// what the workflow does.
// ---------------------------------------------------------------------------

function workflowCode() {
  return readFileSync(WORKFLOW, "utf8")
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.replace(/\s+#.*$/, ""))
    .join("\n");
}

/** The `on:` block: the key's own line plus every indented line under it. */
function triggerBlock(code) {
  const lines = code.split("\n");
  const start = lines.findIndex((line) => /^["']?on["']?\s*:/.test(line));
  assert.notEqual(start, -1, "the workflow has no top-level on: key");
  const block = [lines[start].replace(/^["']?on["']?\s*:/, "")];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    block.push(line);
  }
  return block.join("\n");
}

test("the workflow exists, runs this script by its path, and never runs on push", () => {
  assert.ok(existsSync(WORKFLOW), `${WORKFLOW} is missing`);
  const code = workflowCode();

  assert.match(code, /^\s+run:\s*node scripts\/check-atlas-currency\.mjs\s*$/m, "no step runs node scripts/check-atlas-currency.mjs");
  assert.ok(existsSync(resolve(ROOT, SCRIPT_PATH)), `${SCRIPT_PATH} is missing`);

  const on = triggerBlock(code);
  // The control: "no push" means nothing unless this is the real trigger block.
  assert.match(on, /\bschedule\s*:/, "the on: block has no schedule");
  assert.match(on, /\bworkflow_dispatch\b/, "the on: block has no workflow_dispatch");
  assert.doesNotMatch(on, /\bpush\b/, "the workflow runs on push, so a network flake would become a required check");
  assert.doesNotMatch(on, /\bpull_request/, "the workflow runs on pull requests, so a network flake would become a required check");
  assert.doesNotMatch(code, /:\s*write\b/, "the workflow grants a write permission it has no use for");
});
