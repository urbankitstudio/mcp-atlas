/**
 * Is this server's version listed on the official MCP Registry?
 *
 * publish.yml runs this after `mcp-publisher publish` exits 0, because a zero
 * exit is not proof: the entry is read back. Exact name AND version must match,
 * so a neighbour's entry or an older version never passes.
 *
 * THREE OUTCOMES, because they mean different things (#87). Run 39183889390
 * (0.3.10) failed this step with eight `curl: (28) Operation timed out after
 * 20001 milliseconds with 0 bytes received`. The registry could not be
 * reached at all, so the step could not know whether 0.3.10 was listed. It
 * was: the listing showed it later. Calling that a failure sent a published
 * release to triage. Now:
 *   listed       the registry answers and lists name@version     exit 0
 *   unreachable  every attempt up to the last ended in a        exit 0, ::warning::
 *                transport failure (timeout, connection refused,
 *                reset, 0 bytes, or a 502/503/504/429 that says the
 *                registry is not serving): we could not ask
 *   not-listed   the registry answered, and every page of the    exit 1, ::error::
 *                listing was read without finding the version
 * Any other answer from a reachable registry (another HTTP status, a body
 * that is not the listing) fails as well: it was reachable and did not confirm.
 * The LAST attempt decides between not-listed and unreachable. A listing found
 * on any attempt passes.
 *
 * PAGINATION. GET /v0/servers?search=<name>&limit=100 returns one entry per
 * published version, sorted as strings (0.3.10 sorts between 0.3.1 and 0.3.2),
 * and `metadata.nextCursor` names the next page while there is one. Every page
 * is read before "not listed" is concluded, so a version past the first 100
 * entries is still found.
 *
 * Run locally: node scripts/confirm-registry.mjs <server-name> <version>
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0/servers";
export const PAGE_LIMIT = 100;
export const MAX_PAGES = 20;
export const ATTEMPTS = 8;
export const REQUEST_TIMEOUT_MS = 20_000;
// A listing can trail a successful publish by a minute or two.
export const NOT_LISTED_WAIT_MS = 15_000;
// An unreachable registry is an outage, not lag: back off further each time.
export const transportBackoffMs = (attempt) => Math.min(30_000 * attempt, 120_000);
// publish.yml's timeout-minutes counts on this bound for the whole read-back.
export const DEADLINE_MS = 14 * 60_000;

const UNAVAILABLE_STATUSES = new Set([429, 502, 503, 504]);

/**
 * Every line this script logs carries text the registry controls (a cursor, an
 * error message), and the Actions runner reads any log line that starts with
 * `::` as a workflow command. So every line goes through here first: a control
 * character or a line separator becomes a visible \uXXXX escape, and the
 * registry's text can never start a line of its own.
 */
export function logSafe(text) {
  return String(text).replace(
    /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** One request. Returns the parsed page, or a classified failure. */
async function readPage(fetchImpl, url) {
  let res;
  let body;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    body = await res.text();
  } catch (err) {
    const cause = err?.cause?.code ?? err?.cause?.message ?? "";
    return { kind: "unreachable", detail: `${err?.name ?? "Error"}: ${err?.message ?? err}${cause ? ` (${cause})` : ""}` };
  }
  if (UNAVAILABLE_STATUSES.has(res.status)) {
    return { kind: "unreachable", detail: `HTTP ${res.status}` };
  }
  if (!res.ok) return { kind: "bad-response", detail: `HTTP ${res.status}` };
  if (body.length === 0) return { kind: "unreachable", detail: "HTTP 200 with 0 bytes received" };
  try {
    const page = JSON.parse(body);
    if (!Array.isArray(page?.servers)) return { kind: "bad-response", detail: "the body carries no servers array" };
    return { kind: "page", page };
  } catch {
    return { kind: "bad-response", detail: "the body is not JSON" };
  }
}

/** Walk every page of the listing once. */
export async function findListing({ name, version, fetchImpl = fetch }) {
  let cursor = null;
  const seen = new Set();
  for (let n = 1; n <= MAX_PAGES; n++) {
    const params = new URLSearchParams({ search: name, limit: String(PAGE_LIMIT) });
    if (cursor) params.set("cursor", cursor);
    const r = await readPage(fetchImpl, `${REGISTRY_URL}?${params}`);
    if (r.kind !== "page") return { ...r, pages: n - 1 };
    const hit = r.page.servers.some((s) => s?.server?.name === name && s?.server?.version === version);
    if (hit) return { kind: "listed", pages: n };
    cursor = r.page.metadata?.nextCursor || null;
    if (!cursor) return { kind: "not-listed", pages: n };
    if (seen.has(cursor)) return { kind: "bad-response", detail: `the listing repeated cursor ${cursor}`, pages: n };
    seen.add(cursor);
  }
  return { kind: "bad-response", detail: `the listing ran past ${MAX_PAGES} pages`, pages: MAX_PAGES };
}

/**
 * Retry the walk until it lists the version, attempts run out, or the deadline
 * would pass. Returns { outcome, message }; `log` gets one line per attempt.
 */
export async function confirmRegistry({
  name,
  version,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  log = (line) => console.log(line),
}) {
  const start = now();
  let last = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    last = await findListing({ name, version, fetchImpl });
    if (last.kind === "listed") {
      return { outcome: "listed", message: `registry lists ${name}@${version} (page ${last.pages})` };
    }
    log(logSafe(`attempt ${attempt} of ${ATTEMPTS}: ${last.kind}${last.detail ? `, ${last.detail}` : ""} (${last.pages} page(s) read)`));
    if (attempt === ATTEMPTS) break;
    const wait = last.kind === "unreachable" ? transportBackoffMs(attempt) : NOT_LISTED_WAIT_MS;
    if (now() - start + wait + REQUEST_TIMEOUT_MS > DEADLINE_MS) {
      log(`stopping: another attempt would pass the ${DEADLINE_MS / 60_000}-minute deadline`);
      break;
    }
    await sleep(wait);
  }
  if (last.kind === "unreachable") {
    return {
      outcome: "unreachable",
      message: `could not reach the MCP Registry to confirm ${name}@${version} (${last.detail}). mcp-publisher reported the publish as done; confirm by hand: curl -sG ${REGISTRY_URL} --data-urlencode search=${name}`,
    };
  }
  if (last.kind === "not-listed") {
    return {
      outcome: "not-listed",
      message: `${name}@${version} is not listed on the MCP Registry: it answered, and ${last.pages} page(s) of the listing do not carry that version.`,
    };
  }
  return {
    outcome: "bad-response",
    message: `the MCP Registry answered but did not confirm ${name}@${version}: ${last.detail}.`,
  };
}

/** The exit code and log line for an outcome: only "listed" and "unreachable" exit 0. */
export function report(r) {
  const message = logSafe(r.message);
  if (r.outcome === "listed") return { code: 0, line: message };
  if (r.outcome === "unreachable") return { code: 0, line: `::warning::${message}` };
  return { code: 1, line: `::error::${message}` };
}

export async function main(argv = process.argv.slice(2)) {
  const [name, version] = argv;
  if (!name || !version) {
    console.error("usage: node scripts/confirm-registry.mjs <server-name> <version>");
    return 2;
  }
  const { code, line } = report(await confirmRegistry({ name, version }));
  console.log(line);
  return code;
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
