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
const LS = String.fromCharCode(0x2028);
const NEL = String.fromCharCode(0x85);
const HOSTILE = ["::error::x", "##[warning]x", "a\n::error::x", "##[add-mask]x"];

/** Every physical line, with the script's own leading annotation prefix removed once. */
function physicalLines(lines) {
  return lines
    .join("\n")
    .split(new RegExp(`\\r\\n|\\r|\\n|${LS}|${String.fromCharCode(0x2029)}|${NEL}`))
    .map((l) => l.replace(/^::(error|warning)::/, ""));
}

test("logSafe leaves no line break, no '::' and no '##[' anywhere, and shows each escape", () => {
  for (const text of [...HOSTILE, `x\r::warning::y`, `x${LS}::notice::y`, `x${NEL}::notice::y`, "###[x", ":::x"]) {
    const safe = logSafe(text);
    assert.doesNotMatch(safe, /[\r\n]/, JSON.stringify(text));
    assert.ok(!safe.includes(LS) && !safe.includes(NEL), JSON.stringify(text));
    assert.ok(!safe.includes("::"), `${JSON.stringify(text)} -> ${safe}`);
    assert.ok(!safe.includes("##["), `${JSON.stringify(text)} -> ${safe}`);
  }
  assert.equal(logSafe("::error::x"), "\\u003a:error\\u003a:x");
  assert.equal(logSafe("##[add-mask]x"), "\\u0023#[add-mask]x");
  assert.equal(logSafe("a\n::error::x"), "a\\u000a\\u003a:error\\u003a:x");
});

for (const cursor of HOSTILE) {
  test(`a hostile registry cursor ${JSON.stringify(cursor)} forms no workflow command in the log`, async () => {
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
    for (const line of physicalLines(lines)) {
      assert.ok(!line.includes("::") && !line.includes("##["), `no command in: ${line}`);
    }
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
  for (const line of physicalLines(lines)) {
    assert.ok(!line.includes("::") && !line.includes("##["), `no command in: ${line}`);
  }
  assert.ok(report(r).line.includes("\\u0023#[add-mask]secret"), "the message is shown, escaped");
});

test("publish.yml's confirm job runs this script with the server name and version, and holds no publish identity", () => {
  const wf = readFileSync(resolve(ROOT, ".github/workflows/publish.yml"), "utf8");
  const start = wf.indexOf("\n  confirm-registry:\n");
  assert.ok(start > 0, "the confirm-registry job exists");
  const job = wf.slice(start);
  const code = job.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  assert.match(code, /\n    needs: publish\n/);
  assert.match(
    code,
    /\n    if: \$\{\{ !cancelled\(\) && needs\.publish\.outputs\.mcpreg == 'true' \}\}\n/,
    "the read-back runs after a later publish-job failure, and only once the registry publish reported done",
  );
  assert.match(code, /\n    permissions:\n      contents: read\n    steps:/, "contents: read is its only permission");
  assert.doesNotMatch(code, /id-token|environment:/, "no OIDC identity and no environment");
  assert.match(code, /\n    timeout-minutes: \d+\n/);
  assert.match(code, /- name: Confirm on the MCP Registry/);
  assert.match(code, /VERSION: \$\{\{ needs\.publish\.outputs\.version \}\}/);
  assert.match(code, /node scripts\/confirm-registry\.mjs "\$NAME" "\$VERSION"/);
  assert.doesNotMatch(code, /curl/, "the old inline curl loop is gone");
  const publishJob = wf.slice(wf.indexOf("\n  publish:\n"), start);
  assert.ok(!publishJob.includes("- name: Confirm on the MCP Registry"), "the publish job no longer reads the entry back");
  const timeout = Number(publishJob.match(/\n    timeout-minutes: (\d+)\n/)?.[1]);
  assert.ok(timeout > 0 && timeout <= 27, `the publish job's timeout is back at 27 minutes or less (got ${timeout})`);
  // The two outputs the confirm job reads, and the steps that set them, so a
  // rename on either side cannot skip the read-back in silence.
  assert.match(
    publishJob,
    /\n    outputs:\n      version: \$\{\{ steps\.bump\.outputs\.version \}\}\n      mcpreg: \$\{\{ steps\.mcpreg\.outputs\.published \}\}\n/,
  );
  assert.match(publishJob, /\n        id: bump\n/);
  assert.match(publishJob, /echo "version=\$NEW" >> "\$GITHUB_OUTPUT"/);
  assert.match(publishJob, /\n        id: mcpreg\n/);
  assert.match(publishJob, /echo "published=true" >> "\$GITHUB_OUTPUT"\n              exit 0/);
});
