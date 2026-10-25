/**
 * Tests for scripts/confirm-registry.mjs and the publish.yml step that runs it
 * (#87): a reachable registry that does not list the version FAILS, an
 * unreachable one ends as a warning, a listed version passes from any page.
 *
 * Hermetic: every fetch is a fake, and sleep is recorded, not waited.
 * The page and failure shapes are the ones run 39183889390 and the live
 * listing show: `{ servers: [{ server: { name, version } }], metadata: { nextCursor } }`,
 * and `curl: (28) Operation timed out ... with 0 bytes received`.
 *
 * Usage:  node --test test/confirm-registry.test.mjs
 * Or via: npm run test:policy
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  confirmRegistry,
  findListing,
  logSafe,
  main,
  report,
  ATTEMPTS,
  NOT_LISTED_WAIT_MS,
  transportBackoffMs,
} from "../scripts/confirm-registry.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "io.github.urbankitstudio/mcp-atlas";

const entry = (name, version) => ({ server: { name, version } });
const page = (servers, nextCursor) =>
  new Response(JSON.stringify({ servers, metadata: nextCursor ? { nextCursor, count: servers.length } : { count: servers.length } }), { status: 200 });

function timeout() {
  const err = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  return Promise.reject(err);
}
function refused() {
  const err = new TypeError("fetch failed");
  err.cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  return Promise.reject(err);
}

/** Runs confirmRegistry with a fake fetch and a recording sleep. */
async function run(version, fetchImpl) {
  const sleeps = [];
  const urls = [];
  let clock = 0;
  const r = await confirmRegistry({
    name: NAME,
    version,
    fetchImpl: (url, init) => {
      urls.push(String(url));
      return fetchImpl(url, init);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    log: () => {},
  });
  return { ...r, sleeps, urls };
}

test("a version on the second page of the listing is found, through the cursor", async () => {
  const r = await run("0.3.11", (url) => {
    const cursor = new URL(url).searchParams.get("cursor");
    if (!cursor) return Promise.resolve(page([entry(NAME, "0.2.21"), entry(NAME, "0.3.10")], `${NAME}:0.3.10`));
    assert.equal(cursor, `${NAME}:0.3.10`);
    return Promise.resolve(page([entry(NAME, "0.3.11")]));
  });
  assert.equal(r.outcome, "listed");
  assert.equal(r.urls.length, 2, "read the second page");
  assert.match(r.urls[0], /search=io\.github\.urbankitstudio%2Fmcp-atlas/);
  assert.match(r.urls[0], /limit=100/);
});

test("a reachable registry that never lists the version FAILS, after reading every page", async () => {
  const r = await run("0.3.11", (url) =>
    Promise.resolve(
      new URL(url).searchParams.get("cursor")
        ? page([entry(NAME, "0.3.9")])
        : page([entry(NAME, "0.3.10")], "next"),
    ),
  );
  assert.equal(r.outcome, "not-listed");
  assert.equal(r.urls.length, ATTEMPTS * 2, "both pages read on every attempt");
  assert.deepEqual(r.sleeps, Array(ATTEMPTS - 1).fill(NOT_LISTED_WAIT_MS), "lag gets the short wait");
  assert.equal(report(r).code, 1);
  assert.match(report(r).line, /^::error::/);
});

test("a neighbour's entry at the same version does not pass", async () => {
  const r = await run("0.3.11", () => Promise.resolve(page([entry(`${NAME}-fork`, "0.3.11")])));
  assert.equal(r.outcome, "not-listed");
});

test("every attempt timing out with 0 bytes ends as unreachable, with the longer backoff", async () => {
  const r = await run("0.3.11", timeout);
  assert.equal(r.outcome, "unreachable");
  assert.match(r.message, /could not reach the MCP Registry/);
  assert.match(r.message, /TimeoutError/);
  assert.deepEqual(
    r.sleeps,
    Array.from({ length: ATTEMPTS - 1 }, (_, i) => transportBackoffMs(i + 1)),
    "an outage backs off 30..120 s",
  );
  assert.ok(r.sleeps[0] > NOT_LISTED_WAIT_MS, "the outage backoff is longer than the lag wait");
  assert.equal(report(r).code, 0);
  assert.match(report(r).line, /^::warning::/);
});

test("connection refused, a 503 and an empty 200 body are transport failures too", async () => {
  for (const f of [refused, () => Promise.resolve(new Response("", { status: 503 })), () => Promise.resolve(new Response("", { status: 200 }))]) {
    const r = await run("0.3.11", f);
    assert.equal(r.outcome, "unreachable");
  }
});

test("a 404 or a body that is not the listing FAILS: reachable and not confirmed", async () => {
  for (const f of [() => Promise.resolve(new Response("nope", { status: 404 })), () => Promise.resolve(new Response("<html>", { status: 200 }))]) {
    const r = await run("0.3.11", f);
    assert.equal(r.outcome, "bad-response");
    assert.equal(report(r).code, 1);
  assert.match(report(r).line, /^::error::/);
  }
});

test("an outage that clears passes once the version is listed", async () => {
  let n = 0;
  const r = await run("0.3.11", () => (++n < 3 ? timeout() : Promise.resolve(page([entry(NAME, "0.3.11")]))));
  assert.equal(r.outcome, "listed");
  assert.equal(n, 3);
});

test("the LAST attempt decides: reachable-and-unlisted after an outage FAILS", async () => {
  let n = 0;
  const r = await run("0.3.11", () => (++n < ATTEMPTS ? timeout() : Promise.resolve(page([entry(NAME, "0.3.10")]))));
  assert.equal(r.outcome, "not-listed");
});

test("a cursor that repeats stops the walk instead of looping, and only its length is reported", async () => {
  const r = await findListing({ name: NAME, version: "0.3.11", fetchImpl: () => Promise.resolve(page([entry(NAME, "0.3.10")], "same")) });
  assert.equal(r.kind, "bad-response");
  assert.equal(r.detail, "the listing repeated a cursor (4 characters)");
});

test("main maps the outcomes to exit codes and annotations", async () => {
  assert.equal(await main([]), 2, "no arguments is a usage error");
  assert.deepEqual(report({ outcome: "listed", message: "m" }), { code: 0, line: "m" });
});

// The runner reads `::cmd` at the start of a line (after leading whitespace)
// and the legacy `##[cmd]` anywhere in one (actions/runner ActionCommand.cs).
// The runner also reads THIS file's own output, so a test title or an
// assertion message names a payload by its label, never by its text
// (test/log-hygiene.test.mjs checks every title).
const LS = String.fromCharCode(0x2028);
const NEL = String.fromCharCode(0x85);
const HOSTILE = [
  ["line-start-error", "::error::x"],
  ["legacy-warning", "##[warning]x"],
  ["newline-then-error", "a\n::error::x"],
  ["legacy-add-mask", "##[add-mask]x"],
];

/** Every physical line, with the script's own leading annotation prefix removed once. */
function physicalLines(lines) {
  return lines
    .join("\n")
    .split(new RegExp(`\\r\\n|\\r|\\n|${LS}|${String.fromCharCode(0x2029)}|${NEL}`))
    .map((l) => l.replace(/^::(error|warning)::/, ""));
}

test("logSafe leaves no line break, no double colon and no legacy command opener anywhere, and shows each escape", () => {
  const cases = [
    ...HOSTILE,
    ["cr-then-warning", `x\r::warning::y`],
    ["line-separator-then-notice", `x${LS}::notice::y`],
    ["nel-then-notice", `x${NEL}::notice::y`],
    ["triple-hash", "###[x"],
    ["triple-colon", ":::x"],
  ];
  for (const [label, text] of cases) {
    const safe = logSafe(text);
    assert.doesNotMatch(safe, /[\r\n]/, label);
    assert.ok(!safe.includes(LS) && !safe.includes(NEL), label);
    assert.ok(!safe.includes("::"), label);
    assert.ok(!safe.includes("##["), label);
  }
  assert.equal(logSafe("::error::x"), "\\u003a:error\\u003a:x");
  assert.equal(logSafe("##[add-mask]x"), "\\u0023#[add-mask]x");
  assert.equal(logSafe("a\n::error::x"), "a\\u000a\\u003a:error\\u003a:x");
});

for (const [label, cursor] of HOSTILE) {
  test(`a hostile registry cursor (${label}) forms no workflow command in the log`, async () => {
    const lines = [];
    const r = await confirmRegistry({
      name: NAME,
      version: "0.3.11",
      // The same cursor twice, so the walk stops on a repeated cursor.
      fetchImpl: () => Promise.resolve(page([entry(NAME, "0.3.10")], cursor)),
      sleep: async () => {},
      now: () => 0,
      log: (line) => lines.push(line),
    });
    assert.equal(r.outcome, "bad-response");
    lines.push(report(r).line);
    assert.match(report(r).line, /^::error::the MCP Registry answered but did not confirm/);
    physicalLines(lines).forEach((line, i) => {
      assert.ok(!line.includes("::") && !line.includes("##["), `no command in log line ${i}`);
    });
    assert.ok(report(r).line.includes(`a cursor (${cursor.length} characters)`), "the cursor's length, not the cursor");
  });
}

test("a hostile fetch error message forms no workflow command in the log either", async () => {
  const lines = [];
  const message = "##[add-mask]secret ::error::forged\n::warning::forged";
  const r = await confirmRegistry({
    name: NAME,
    version: "0.3.11",
    fetchImpl: () => Promise.reject(new Error(message)),
    sleep: async () => {},
    now: () => 0,
    log: (line) => lines.push(line),
  });
  assert.equal(r.outcome, "unreachable");
  lines.push(report(r).line);
  assert.match(report(r).line, /^::warning::could not reach the MCP Registry/);
  physicalLines(lines).forEach((line, i) => {
    assert.ok(!line.includes("::") && !line.includes("##["), `no command in log line ${i}`);
  });
  assert.ok(report(r).line.includes("\\u0023#[add-mask]secret"), "the message is shown, escaped");
});

// The workflow is read as text, without a YAML parser: a job is the lines from
// its `  name:` header to the next job header, comment lines dropped, and a
// step is the lines from its `      - ` to the next one. Each check is bound to
// the block it is about, so a token that moves to the wrong step or job fails.
const WF = readFileSync(resolve(ROOT, ".github/workflows/publish.yml"), "utf8");

function jobBlock(name) {
  const header = `\n  ${name}:\n`;
  const start = WF.indexOf(header);
  assert.ok(start > 0, `the ${name} job exists`);
  const rest = WF.slice(start + header.length);
  const next = rest.search(/\n  [A-Za-z0-9_-]+:\n/);
  return (next === -1 ? rest : rest.slice(0, next))
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
}

function stepBlocks(job) {
  return job.split(/\n(?=      - )/).slice(1);
}

function stepWith(job, re, what) {
  const found = stepBlocks(job).filter((s) => re.test(s));
  assert.equal(found.length, 1, `exactly one step ${what}`);
  return found[0];
}

test("publish.yml's confirm job runs this script with the server name and version, and holds no publish identity", () => {
  const job = jobBlock("confirm-registry");
  assert.match(job, /^    needs: publish$/m);
  assert.match(
    job,
    /^    if: \$\{\{ !cancelled\(\) && needs\.publish\.outputs\.mcpreg == 'true' \}\}$/m,
    "eligible after a later publish-job failure, and only once the registry publish reported done",
  );
  assert.equal(job.match(/^\s+if:/gm)?.length, 1, "the job's own if: is the only one in the job");
  assert.doesNotMatch(job, /continue-on-error/, "a failed read-back fails the job");
  assert.match(job, /^    permissions:\n      contents: read\n    steps:$/m, "contents: read is its only permission");
  assert.doesNotMatch(job, /id-token|environment:/, "no OIDC identity and no environment");
  assert.match(job, /^    timeout-minutes: \d+$/m);
  assert.doesNotMatch(job, /curl/, "the old inline curl loop is gone");
  const confirm = stepWith(job, /^      - name: Confirm on the MCP Registry$/m, "named Confirm on the MCP Registry");
  assert.match(confirm, /^\s+VERSION: \$\{\{ needs\.publish\.outputs\.version \}\}$/m, "the step sets VERSION itself");
  assert.match(confirm, /node scripts\/confirm-registry\.mjs "\$NAME" "\$VERSION"/);
  assert.doesNotMatch(confirm, /^\s+if:/m, "the step runs whenever the job does");
  assert.doesNotMatch(confirm, /continue-on-error/);
});

test("publish.yml's publish job hands the confirm job its version and registry outcome from the right steps", () => {
  const job = jobBlock("publish");
  assert.ok(!job.includes("- name: Confirm on the MCP Registry"), "the publish job no longer reads the entry back");
  const timeout = Number(job.match(/^    timeout-minutes: (\d+)$/m)?.[1]);
  assert.ok(timeout > 0 && timeout <= 27, `the publish job's timeout is back at 27 minutes or less (got ${timeout})`);
  assert.match(
    job,
    /^    outputs:\n      version: \$\{\{ steps\.bump\.outputs\.version \}\}\n      mcpreg: \$\{\{ steps\.mcpreg\.outputs\.published \}\}$/m,
  );
  // The producers: the step with id bump writes version, and the step with id
  // mcpreg is the registry publish and writes published=true.
  const bump = stepWith(job, /^        id: bump$/m, "with id bump");
  assert.match(bump, /echo "version=\$NEW" >> "\$GITHUB_OUTPUT"/);
  const mcpreg = stepWith(job, /^        id: mcpreg$/m, "with id mcpreg");
  assert.match(mcpreg, /^      - name: Publish to the MCP Registry$/m);
  assert.match(mcpreg, /echo "published=true" >> "\$GITHUB_OUTPUT"\n\s+exit 0/);
});
