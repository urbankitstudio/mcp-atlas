/**
 * The test runner's output reaches the CI log raw (ci.yml and publish.yml run
 * `npm run test:policy`), and the Actions runner reads a workflow command in
 * it: `::cmd` at the start of a line, the legacy `##[cmd]` anywhere. So no
 * test title may carry "::", "##[", a control character, a line separator or
 * a bidi control. A hostile fixture is named by a label, never by its text.
 *
 * This runs every other test:policy file under test/title-reporter.mjs, which
 * prints each title as a JSON line, and judges every title it prints.
 *
 * Usage:  node --test test/log-hygiene.test.mjs
 * Or via: npm run test:policy
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "test/log-hygiene.test.mjs";
const REPORTER = pathToFileURL(resolve(ROOT, "test/title-reporter.mjs")).href;

/** Why a title is unsafe in a CI log, or null when it is safe. */
export function unsafeTitle(name) {
  if (name.includes("::")) return "a double colon";
  if (name.includes("##[")) return "a legacy command opener";
  for (const c of name) {
    const n = c.codePointAt(0);
    if (n < 0x20 || (n >= 0x7f && n <= 0x9f)) return "a control character";
    if (n === 0x2028 || n === 0x2029) return "a line separator";
    if (/\p{Bidi_C}/u.test(c)) return "a bidi control";
  }
  return null;
}

/** A title as hex code points: a failure message must not print the title raw. */
const hex = (name) => [...name].map((c) => c.codePointAt(0).toString(16)).join(" ");

test("the title check itself: each unsafe shape is caught, and an ordinary title passes", () => {
  for (const name of ["a ::error:: b", "a ##[warning] b", `a${String.fromCharCode(10)}b`, `a${String.fromCharCode(0x85)}b`, `a${String.fromCharCode(0x2028)}b`, `a${String.fromCharCode(0x202e)}b`]) {
    assert.notEqual(unsafeTitle(name), null, hex(name));
  }
  assert.equal(unsafeTitle("a hostile registry cursor (legacy-warning) forms no workflow command in the log"), null);
});

test("no test title in the other test:policy files carries a workflow command or a control character", () => {
  const files = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"))
    .scripts["test:policy"].split(/\s+/)
    .filter((a) => a.endsWith(".mjs") && a !== SELF);
  assert.ok(files.length >= 5, `the other test:policy files were found (${files.length})`);
  // The parent runner marks its child processes with NODE_TEST_CONTEXT, which
  // would make this nested run report to it instead of through the reporter.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ["--test", `--test-reporter=${REPORTER}`, ...files], {
    cwd: ROOT,
    encoding: "utf8",
    env,
    timeout: 120_000,
  });
  const titles = run.stdout
    .split("\n")
    .filter((l) => l.startsWith('"'))
    .map((l) => JSON.parse(l));
  // CONTROL: the reporter did print the titles, a known one among them.
  assert.ok(titles.length >= 100, `the reporter printed the titles (${titles.length})`);
  assert.ok(titles.includes("a hostile fetch error message forms no workflow command in the log either"));
  const bad = titles.map((t) => [t, unsafeTitle(t)]).filter(([, why]) => why !== null);
  assert.deepEqual(
    bad.map(([t, why]) => `${why}: ${hex(t)}`),
    [],
    "every title is safe in a CI log",
  );
});
