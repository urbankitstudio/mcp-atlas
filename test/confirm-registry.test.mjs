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

test("a cursor that repeats stops the walk instead of looping", async () => {
  const r = await findListing({ name: NAME, version: "0.3.11", fetchImpl: () => Promise.resolve(page([entry(NAME, "0.3.10")], "same")) });
  assert.equal(r.kind, "bad-response");
  assert.match(r.detail, /repeated cursor/);
});

test("main maps the outcomes to exit codes and annotations", async () => {
  assert.equal(await main([]), 2, "no arguments is a usage error");
  assert.deepEqual(report({ outcome: "listed", message: "m" }), { code: 0, line: "m" });
});

test("publish.yml's confirm step runs this script with the server name and version", () => {
  const wf = readFileSync(resolve(ROOT, ".github/workflows/publish.yml"), "utf8");
  const step = wf.slice(wf.indexOf("- name: Confirm on the MCP Registry"), wf.indexOf("- name: Report"));
  assert.ok(step.length > 0, "the confirm step exists");
  const code = step.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  assert.match(code, /node scripts\/confirm-registry\.mjs "\$NAME" "\$VERSION"/);
  assert.doesNotMatch(code, /curl/, "the old inline curl loop is gone");
});

