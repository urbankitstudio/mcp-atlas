/**
 * Smoke test for @urbankitstudio/mcp-atlas
 *
 * Spawns the built server as a child process, sends MCP initialize +
 * a list_counties call, and verifies the response contains real atlas data.
 *
 * Usage:  node test/smoke.mjs
 * Or via: npm run smoke
 */

import { spawn } from "node:child_process";
import { atlas } from "@urbankitstudio/atlas";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(__dirname, "../dist/server.js");

let exitCode = 0;

/** Send a JSON-RPC message (newline-delimited) to the server's stdin */
function sendMessage(proc, id, method, params = {}) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  proc.stdin.write(msg + "\n");
}

/** Collect a parsed JSON-RPC response from the server's stdout */
async function readResponse(proc) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString();
      // Responses are newline-delimited
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        proc.stdout.off("data", onData);
        try {
          resolve(JSON.parse(buf.slice(0, nl)));
        } catch (e) {
          reject(new Error(`Bad JSON: ${buf.slice(0, nl)}`));
        }
      }
    };
    proc.stdout.on("data", onData);
    // Timeout after 5 s
    setTimeout(() => {
      proc.stdout.off("data", onData);
      reject(new Error("Timeout waiting for server response"));
    }, 5000);
  });
}

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    exitCode = 1;
  } else {
    console.log("PASS:", msg);
  }
}

async function run() {
  const proc = spawn("node", [serverEntry], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  proc.stderr.on("data", (d) => {
    process.stderr.write("[server] " + d.toString());
  });

  proc.on("error", (err) => {
    console.error("Failed to start server:", err.message);
    exitCode = 1;
  });

  // Step 1: initialize
  sendMessage(proc, 1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0.0.1" },
  });
  const initResp = await readResponse(proc);
  assert(initResp.result?.serverInfo?.name === "mcp-atlas", "server name is mcp-atlas");

  // Step 2: initialized notification
  proc.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"
  );

  // Step 3: list tools
  sendMessage(proc, 2, "tools/list", {});
  const toolsResp = await readResponse(proc);
  const toolNames = (toolsResp.result?.tools ?? []).map((t) => t.name);
  assert(toolNames.includes("list_counties"), "list_counties tool registered");
  assert(toolNames.includes("find_county"), "find_county tool registered");
  assert(toolNames.includes("get_parcel_endpoint"), "get_parcel_endpoint tool registered");
  assert(toolNames.includes("build_owner_query"), "build_owner_query tool registered");
  assert(toolNames.includes("get_city_datasets"), "get_city_datasets tool registered");
  assert(toolNames.length === 5, `tools/list returns exactly 5 tools (got ${toolNames.length}: ${toolNames.join(", ")})`);
  // The hosted twin's argument caps and enum, as the client sees them.
  const cityTool = (toolsResp.result?.tools ?? []).find((t) => t.name === "get_city_datasets");
  const cityProps = cityTool?.inputSchema?.properties ?? {};
  assert(
    cityProps.city?.maxLength === 80 && cityProps.state?.maxLength === 40 && cityProps.street?.maxLength === 120,
    "get_city_datasets advertises the hosted tool's maxLengths (80 / 40 / 120)",
  );
  assert(
    JSON.stringify(cityProps.kind?.enum) === JSON.stringify(["violations", "permits", "zoning"]),
    "get_city_datasets advertises the hosted tool's kind enum",
  );
  assert(!(cityTool?.inputSchema?.required ?? []).length, "get_city_datasets requires no argument (no city lists every city)");

  // Step 4: call list_counties with state=IL
  sendMessage(proc, 3, "tools/call", {
    name: "list_counties",
    arguments: { state: "IL" },
  });
  const listResp = await readResponse(proc);
  const listText = listResp.result?.content?.[0]?.text ?? "";
  assert(listText.includes("IL"), "list_counties returns Illinois entries");
  assert(listText.includes("Kane"), "list_counties includes Kane County");

  // Step 5: call find_county for Kane IL
  sendMessage(proc, 4, "tools/call", {
    name: "find_county",
    arguments: { query: "Kane IL" },
  });
  const findResp = await readResponse(proc);
  const findText = findResp.result?.content?.[0]?.text ?? "";
  assert(findText.includes("gistech.countyofkane.org"), "find_county returns Kane REST URL");
  assert(findText.includes("TaxName"), "find_county returns owner field TaxName");

  // Step 6: build_owner_query for Kane IL, SMITH
  sendMessage(proc, 5, "tools/call", {
    name: "build_owner_query",
    arguments: { state: "IL", county: "Kane", owner_name: "SMITH" },
  });
  const queryResp = await readResponse(proc);
  const queryText = queryResp.result?.content?.[0]?.text ?? "";
  assert(queryText.includes("TaxName"), "build_owner_query uses TaxName field");
  assert(queryText.includes("UPPER(TaxName)"), "build_owner_query uses UPPER() wrapper");
  assert(queryText.includes("SMITH"), "build_owner_query includes owner name");
  // Kane pages, so the server must still send resultRecordCount=25 and say so
  // (atlas 0.6.30 pagination flag; the refusing branch is covered in test:policy).
  assert(queryText.includes("&resultRecordCount=25"), "build_owner_query keeps resultRecordCount=25 on a paginating layer");
  assert(queryText.includes("  - Returns up to 25 records\n"), "build_owner_query keeps the 'Returns up to 25 records' note on a paginating layer");

  // Step 6b: an owner name cannot escape the SQL string literal.
  //
  // A `where` is SQL and a single quote closes the literal. encodeURIComponent is
  // not an escape here: `'` and `)` are both unreserved, so `A') OR 1=1 --` used to
  // pass through intact and arrive at a county's ArcGIS server as a well-formed
  // predicate with the tail commented out. Nothing of ours is at risk - the server
  // executes nothing and holds no credentials - but the payload ships in a public
  // npm package and points at third-party government endpoints, and the realistic
  // route is indirect prompt injection steering a client into the call.
  //
  // Both outputs are checked because there are two of them: the URL, and the WHERE
  // clause printed for a human to paste. Escaping one and not the other is the same
  // bug with a longer path to it.
  sendMessage(proc, 51, "tools/call", {
    name: "build_owner_query",
    arguments: { state: "IL", county: "Kane", owner_name: "A') OR 1=1 --" },
  });
  const injResp = await readResponse(proc);
  const injText = injResp.result?.content?.[0]?.text ?? "";
  // Assert on the bytes the user actually receives rather than decoding: the
  // output legitimately contains bare `%` LIKE wildcards, so decodeURIComponent
  // throws on it. Folding %20 back to a space is all that is needed to compare
  // the URL copy and the printed clause against the same shape.
  const injFlat = injText.replace(/%20/g, " ");
  // Twice, not once: the URL and the printed clause are built separately, so a
  // single occurrence means one of the two paths escaped and the other did not.
  // Asserting mere presence passed under both halves of the sabotage proof.
  assert(
    injText.split("A'')").length - 1 === 2,
    "build_owner_query doubles the quote in BOTH the URL and the printed WHERE clause",
  );
  assert(
    !injFlat.includes("A') OR"),
    "build_owner_query leaves no closed literal followed by an injected OR, in either the URL or the printed WHERE clause",
  );

  // Step 7: THE CASE THAT COST A REAL USER.
  //
  // Oakland County MI documents NAME1 and NAME2 as owner columns, and neither
  // carries a value in any record sampled; the atlas carries a reviewed
  // not_published record for it. Before this, list_counties called such a
  // county "owner+APN", find_county printed the column as usable, and
  // build_owner_query handed back a query returning zero rows forever - so
  // the only way to find out was to spend a request and get nothing. Five
  // other counties share the shape in atlas 0.6.2.
  //
  // This fixture was Wake County NC until 2026-09-02. Wake's "empty OWNER
  // column" advisory came from an audit predicate that compared against NULL
  // and was reverted before atlas 0.6.1: Wake publishes owner names on
  // 437,715 rows, and no published atlas carries an override for it.
  sendMessage(proc, 6, "tools/call", {
    name: "list_counties",
    arguments: { state: "MI" },
  });
  const miResp = await readResponse(proc);
  const miText = miResp.result?.content?.[0]?.text ?? "";
  const oaklandRow = miText.split("\n").find((l) => l.includes("Oakland")) ?? "";
  assert(oaklandRow.length > 0, "list_counties includes Oakland County");
  assert(
    oaklandRow.includes("publishes no owner name"),
    "list_counties SAYS Oakland publishes no owner name",
  );
  assert(!oaklandRow.includes("owner+APN"), "list_counties does not claim owner+APN for Oakland");

  sendMessage(proc, 7, "tools/call", {
    name: "find_county",
    arguments: { query: "Oakland MI" },
  });
  const oaklandFind = await readResponse(proc);
  const oaklandFindText = oaklandFind.result?.content?.[0]?.text ?? "";
  assert(
    oaklandFindText.includes("NOT AVAILABLE"),
    "find_county states Oakland's owner field is not available",
  );

  sendMessage(proc, 8, "tools/call", {
    name: "build_owner_query",
    arguments: { state: "MI", county: "Oakland", owner_name: "SMITH" },
  });
  const oaklandQuery = await readResponse(proc);
  const oaklandQueryText = oaklandQuery.result?.content?.[0]?.text ?? "";
  assert(
    oaklandQueryText.includes("OWNER NAME NOT AVAILABLE"),
    "build_owner_query REFUSES for Oakland instead of returning a dud query",
  );
  assert(
    !oaklandQueryText.includes("UPPER(NAME1)"),
    "build_owner_query does not hand back an owner WHERE clause for Oakland",
  );

  // Step 8: shared statewide layers. Miami-Dade's second endpoint is Florida's
  // FDOR layer: every county's rows, scoped by CO_NO=23, and it serves no
  // attribute search. The scope must be printed and the owner query refused
  // for that endpoint, while the county's own layer still gets one. The unit
  // rules live in test/search-policy.test.mjs; this checks the printed output.
  sendMessage(proc, 9, "tools/call", {
    name: "get_parcel_endpoint",
    arguments: { state: "FL", county: "Miami-Dade" },
  });
  const mdEndpoint = (await readResponse(proc)).result?.content?.[0]?.text ?? "";
  assert(mdEndpoint.includes("Scope: CO_NO=23"), "get_parcel_endpoint prints Miami-Dade's FDOR scope");
  assert(
    mdEndpoint.includes("Attribute search: not offered (location queries only)"),
    "get_parcel_endpoint says the FDOR layer offers no attribute search",
  );

  sendMessage(proc, 10, "tools/call", {
    name: "build_owner_query",
    arguments: { state: "FL", county: "Miami-Dade", owner_name: "SMITH" },
  });
  const mdQuery = (await readResponse(proc)).result?.content?.[0]?.text ?? "";
  assert(mdQuery.includes("UPPER(TRUE_OWNER1)"), "build_owner_query still serves Miami-Dade's own layer");
  assert(mdQuery.includes("OWNER SEARCH NOT OFFERED"), "build_owner_query refuses the FDOR layer");
  assert(!mdQuery.includes("UPPER(OWN_NAME)"), "build_owner_query hands back no FDOR owner WHERE clause");

  // Pulaski AR sits on Arkansas's statewide layer with a scope and a searchable
  // owner column, so the printed clause must lead with the scope.
  sendMessage(proc, 11, "tools/call", {
    name: "build_owner_query",
    arguments: { state: "AR", county: "Pulaski", owner_name: "SMITH" },
  });
  const arQuery = (await readResponse(proc)).result?.content?.[0]?.text ?? "";
  assert(arQuery.includes("WHERE clause: (countyfips"), "build_owner_query ANDs Pulaski's scope in front of the owner match");
  // The URL is built separately from the printed clause; check both carry it.
  assert(arQuery.includes("?where=(countyfips%20%3D"), "build_owner_query's URL carries Pulaski's scope too");

  // Orleans (atlas 0.6.13+) marks its layer attributeSearch: "unsupported": owner
  // and address fields come back only from location queries, not a where-clause.
  sendMessage(proc, 12, "tools/call", {
    name: "build_owner_query",
    arguments: { state: "LA", county: "Orleans Parish", owner_name: "SMITH" },
  });
  const orleansQuery = (await readResponse(proc)).result?.content?.[0]?.text ?? "";
  assert(
    orleansQuery.includes("OWNER SEARCH NOT OFFERED") && orleansQuery.includes("Query the layer by location"),
    "build_owner_query refuses Orleans' unsupported attribute search and points to a location query",
  );

  // The shared Owner line (get_parcel_endpoint, find_county) must say the same.
  sendMessage(proc, 13, "tools/call", {
    name: "get_parcel_endpoint",
    arguments: { state: "LA", county: "Orleans Parish" },
  });
  const orleansEndpoint = (await readResponse(proc)).result?.content?.[0]?.text ?? "";
  assert(
    orleansEndpoint.includes("Attribute search: not offered (location queries only)") &&
      !orleansEndpoint.includes("NOT AVAILABLE"),
    "get_parcel_endpoint says Orleans offers location queries only, not attribute search",
  );

  // Step 9 (0.2.14, reworked 0.3.8): a county the atlas does not hold gets the
  // coverage answer from @urbankitstudio/atlas, the text the hosted MCP, the
  // REST API and the `uks` CLI print. status "not-in-atlas" reads as the
  // NOT_IN_ATLAS_WHY sentence. This server has no network tool, so the answer
  // carries the free hosted request path instead of a dead end.
  sendMessage(proc, 14, "tools/call", {
    name: "find_county",
    arguments: { query: "Nowhere County IL" },
  });
  const missFind = (await readResponse(proc)).result?.content?.[0]?.text ?? "";
  assert(
    missFind.startsWith("This county is not in the UrbanKit atlas.\n") && !missFind.includes("No county matched"),
    "find_county answers a made-up county with the not-in-atlas coverage answer",
  );
  assert(
    missFind.includes("https://urbankitstudio.com/api/atlas/request") &&
      missFind.includes("request_county") &&
      missFind.includes("offer to request it for the person you are helping"),
    "find_county's not-in-atlas answer carries the hosted request URL and tool name",
  );
  // The endpoint's parser keeps only county_fips or state_slug + county_slug and
  // drops other keys, so a body built from bare "state"/"county" 400s.
  assert(
    missFind.includes('{"state_slug":"illinois","county_slug":"nowhere-county"}') && !missFind.includes('{"state":'),
    "the request body names the keys the request endpoint accepts, with the state resolved to its slug",
  );

  // A trailing word that names no state must not become the request's state.
  sendMessage(proc, 141, "tools/call", {
    name: "find_county",
    arguments: { query: "Nowhere County ZZ" },
  });
  const zzFind = (await readResponse(proc)).result?.content?.[0]?.text ?? "";
  assert(
    zzFind.startsWith("This county is not in the UrbanKit atlas.\n") &&
      zzFind.includes('{"county_fips":"<5 digits>"}') &&
      !zzFind.includes('"state_slug"'),
    "find_county sends no state_slug for a trailing word that is not a state, and asks for a FIPS code",
  );

  sendMessage(proc, 142, "tools/call", {
    name: "find_county",
    arguments: { query: "99999" },
  });
  const fipsMiss = (await readResponse(proc)).result?.content?.[0]?.text ?? "";
  assert(
    fipsMiss.startsWith("This county is not in the UrbanKit atlas.\n") && fipsMiss.includes('{"county_fips":"99999"}'),
    "find_county names an unknown FIPS code in the request body",
  );

  sendMessage(proc, 15, "tools/call", {
    name: "get_parcel_endpoint",
    arguments: { state: "IL", county: "Nowhere" },
  });
  const missEndpoint = (await readResponse(proc)).result?.content?.[0]?.text ?? "";
  assert(
    missEndpoint.startsWith("This county is not in the UrbanKit atlas.\n") &&
      missEndpoint.includes('{"state_slug":"illinois","county_slug":"nowhere-county"}') &&
      missEndpoint.includes("https://urbankitstudio.com/api/atlas/request"),
    "get_parcel_endpoint's not-in-atlas answer carries the coverage answer and a request body",
  );

  sendMessage(proc, 16, "tools/call", {
    name: "build_owner_query",
    arguments: { state: "IL", county: "Nowhere", owner_name: "SMITH" },
  });
  const missQuery = (await readResponse(proc)).result?.content?.[0]?.text ?? "";
  assert(
    missQuery.startsWith("This county is not in the UrbanKit atlas.\n") &&
      missQuery.includes('{"state_slug":"illinois","county_slug":"nowhere-county"}') &&
      missQuery.includes("https://urbankitstudio.com/api/atlas/request"),
    "build_owner_query's not-in-atlas answer carries the coverage answer and a request body",
  );

  // Step 11 (0.3.8): a county the atlas RECORDS but cannot serve (status
  // "no-public-data"). Shelby TN is licence-restricted: atlas 0.6.38 carries its
  // reason, the check date and the county office. The three county tools give
  // one answer, and none prints an endpoint or an owner query for it.
  const SHELBY_WHY = "ReGIS publishes Shelby County's parcels under terms that bar public display";
  const shelbyRequestBody = '{"county_fips":"47157","county_name":"Shelby","state_abbrev":"TN"}';
  for (const [id, name, args] of [
    [20, "find_county", { query: "Shelby TN" }],
    [21, "get_parcel_endpoint", { state: "TN", county: "Shelby" }],
    [22, "build_owner_query", { state: "TN", county: "Shelby", owner_name: "SMITH" }],
  ]) {
    sendMessage(proc, id, "tools/call", { name, arguments: args });
    const shelby = (await readResponse(proc)).result?.content?.[0]?.text ?? "";
    assert(
      shelby.startsWith("Shelby, Tennessee (TN)\nFIPS: 47157\n") && shelby.includes(SHELBY_WHY),
      `${name} gives the licence-restricted reason for Shelby TN`,
    );
    assert(
      shelby.includes("Checked: 2026-10-17") && shelby.includes("County office: Shelby County ReGIS"),
      `${name} gives Shelby TN's check date and county office`,
    );
    assert(
      shelby.includes("We recheck counties like this one.") &&
        shelby.includes(shelbyRequestBody) &&
        shelby.includes("https://urbankitstudio.com/api/atlas/request"),
      `${name} gives Shelby TN's recheck line and a request body keyed by FIPS`,
    );
    assert(
      !shelby.includes("not in the UrbanKit atlas") &&
        !shelby.includes("no REST endpoint mapped") &&
        !shelby.includes("URL:") &&
        !shelby.includes("WHERE clause"),
      `${name} prints no endpoint, no owner query and no not-in-atlas line for Shelby TN`,
    );
  }

  // The coverage block's optional lines, from real 0.6.38 records: a planned
  // recheck date (Columbia PA) and the county's own paid product (Lancaster PA).
  sendMessage(proc, 23, "tools/call", { name: "get_parcel_endpoint", arguments: { state: "PA", county: "Columbia" } });
  const columbia = (await readResponse(proc)).result?.content?.[0]?.text ?? "";
  assert(columbia.includes("Next check: 2026-10-24"), "get_parcel_endpoint prints Columbia PA's planned recheck date");
  sendMessage(proc, 24, "tools/call", { name: "get_parcel_endpoint", arguments: { state: "PA", county: "Lancaster" } });
  const lancaster = (await readResponse(proc)).result?.content?.[0]?.text ?? "";
  assert(
    lancaster.includes("County product: LanCo View PLUS + Data Hub Premium, https://lancastercountypa.gov/2697/LanCo-View-PLUS"),
    "get_parcel_endpoint prints Lancaster PA's own paid product",
  );

  // list_counties keeps listing served counties only: Shelby is recorded but
  // unserved, Davidson is served.
  sendMessage(proc, 25, "tools/call", { name: "list_counties", arguments: { state: "TN" } });
  const tnList = (await readResponse(proc)).result?.content?.[0]?.text ?? "";
  assert(tnList.includes("Davidson"), "list_counties lists a served Tennessee county (Davidson)");
  assert(!tnList.includes("Shelby"), "list_counties leaves out Shelby, recorded but not served");

  // The last word of a find_county query is a state ONLY when it names one.
  // Until 0.3.8 any final word of 2 or more than 3 letters was taken for a state,
  // so "Kane County" and "Orleans Parish" matched nothing, and the not-in-atlas
  // answer would have told an agent to request counties the atlas serves.
  let findId = 30;
  for (const [query, header] of [
    ["Kane County", "Kane, Illinois (IL)\nFIPS: 17089\n"],
    ["Cook County IL", "Cook, Illinois (IL)\nFIPS: 17031\n"],
    ["Orleans Parish", "Orleans Parish, Louisiana (LA)\nFIPS: 22071\n"],
    ["Orleans Parish LA", "Orleans Parish, Louisiana (LA)\nFIPS: 22071\n"],
    ["St. Louis County MO", "St. Louis, Missouri (MO)\nFIPS: 29189\n"],
    ["17031", "Cook, Illinois (IL)\nFIPS: 17031\n"],
    // A comma between the words is a space, not part of the county name. (A
    // tab is refused at the schema since 0.3.11; see the free-text step below.)
    ["Cook County, IL", "Cook, Illinois (IL)\nFIPS: 17031\n"],
    // A two-word state name is a state suffix, tried before the last word alone.
    ["Kings New York", "Kings, New York (NY)\nFIPS: 36047\n"],
    ["Kanawha West Virginia", "Kanawha, West Virginia (WV)\nFIPS: 54039\n"],
  ]) {
    sendMessage(proc, findId++, "tools/call", { name: "find_county", arguments: { query } });
    const found = (await readResponse(proc)).result?.content?.[0]?.text ?? "";
    assert(
      found.startsWith(header) && !found.includes("not in the UrbanKit atlas"),
      `find_county resolves "${query}"`,
    );
  }

  // The comma must not cost a recorded-but-unserved county its coverage answer.
  sendMessage(proc, findId++, "tools/call", { name: "find_county", arguments: { query: "Shelby County, TN" } });
  const shelbyComma = (await readResponse(proc)).result?.content?.[0]?.text ?? "";
  assert(
    shelbyComma.startsWith("Shelby, Tennessee (TN)\nFIPS: 47157\n") && shelbyComma.includes(SHELBY_WHY),
    'find_county gives "Shelby County, TN" its licence-restricted coverage answer',
  );

  // A state that names no state is never sent as the request's state_slug.
  for (const [tool, args] of [
    ["get_parcel_endpoint", { state: "ZZ", county: "Nowhere" }],
    ["build_owner_query", { state: "Ill.", county: "Nowhere", owner_name: "SMITH" }],
  ]) {
    sendMessage(proc, findId++, "tools/call", { name: tool, arguments: args });
    const badState = (await readResponse(proc)).result?.content?.[0]?.text ?? "";
    assert(
      badState.startsWith("This county is not in the UrbanKit atlas.\n") &&
        badState.includes('{"county_fips":"<5 digits>"}') &&
        !badState.includes('"state_slug"'),
      `${tool} sends no state_slug for the state "${args.state}" and asks for a FIPS code`,
    );
  }

  // A blank query is a short error, not a dump of every record.
  sendMessage(proc, findId++, "tools/call", { name: "find_county", arguments: { query: "  " } });
  const blank = (await readResponse(proc)).result;
  const blankText = blank?.content?.[0]?.text ?? "";
  assert(
    blank?.isError === true && blankText.startsWith("Give a county name") && blankText.length < 200,
    "find_county answers a whitespace-only query with a short error",
  );

  // A served county still prints what it printed before 0.3.8: the record, no
  // coverage block. Kane IL, whose full text smoke step 5 and 6 also read.
  sendMessage(proc, 26, "tools/call", { name: "find_county", arguments: { query: "Kane IL" } });
  const kaneFind = (await readResponse(proc)).result?.content?.[0]?.text ?? "";
  assert(
    kaneFind.startsWith("Kane, Illinois (IL)\nFIPS: 17089\nEndpoints (") &&
      kaneFind.includes("\n  URL: https://gistech.countyofkane.org/"),
    "find_county prints a served county's record unchanged (Kane IL)",
  );
  sendMessage(proc, 27, "tools/call", { name: "get_parcel_endpoint", arguments: { state: "IL", county: "Kane" } });
  const kaneEndpoint = (await readResponse(proc)).result?.content?.[0]?.text ?? "";
  assert(
    kaneEndpoint.startsWith("Kane County, Illinois (IL)\nFIPS: 17089\n\nEndpoint 1:\n  URL:         https://gistech.countyofkane.org/"),
    "get_parcel_endpoint prints a served county's record unchanged (Kane IL)",
  );
  assert(
    !kaneFind.includes("Checked:") && !kaneEndpoint.includes("Checked:") && !kaneEndpoint.includes("request_county"),
    "a served county carries no coverage answer",
  );

  // Step 10 (0.3.0): get_city_datasets. Answers from the bundled registry; the
  // server never fetches, so the URL it returns is a string for the agent to run.
  sendMessage(proc, 17, "tools/call", {
    name: "get_city_datasets",
    arguments: { city: "Dallas", kind: "permits", street: "600 Commerce St, Dallas, TX" },
  });
  const dallasResp = await readResponse(proc);
  let dallas = {};
  try {
    dallas = JSON.parse(dallasResp.result?.content?.[0]?.text ?? "");
  } catch {
    /* left empty: the asserts below fail with a clear message */
  }
  assert(dallasResp.result?.isError !== true, "get_city_datasets is not an error for Dallas");
  assert(dallas.found === true && dallas.city?.slug === "dallas", "get_city_datasets finds Dallas");
  assert(
    typeof dallas.datasets?.[0]?.endpoint === "string" && dallas.datasets[0].endpoint.startsWith("https://"),
    "get_city_datasets returns a Dallas endpoint",
  );
  assert(
    dallas.datasets?.[0]?.query_url?.startsWith(dallas.datasets[0].endpoint) &&
      dallas.datasets[0].query_url.includes("600%20Commerce%20St") &&
      !dallas.datasets[0].query_url.includes("%2C"),
    "get_city_datasets returns a ready query_url for the street, cut at the comma",
  );

  sendMessage(proc, 18, "tools/call", {
    name: "get_city_datasets",
    arguments: { city: "Nowhereville", state: "ZZ" },
  });
  const noCityResp = await readResponse(proc);
  let noCity = {};
  try {
    noCity = JSON.parse(noCityResp.result?.content?.[0]?.text ?? "");
  } catch {
    /* see above */
  }
  assert(noCity.found === false, "get_city_datasets answers found:false for an unknown city");
  assert(!("datasets" in noCity), "get_city_datasets returns no dataset for an unknown city");

  sendMessage(proc, 19, "tools/call", { name: "get_city_datasets", arguments: {} });
  const allCitiesResp = await readResponse(proc);
  let allCities = {};
  try {
    allCities = JSON.parse(allCitiesResp.result?.content?.[0]?.text ?? "");
  } catch {
    /* see above */
  }
  assert(
    allCities.total_cities > 0 && allCities.cities?.some((c) => c.slug === "dallas"),
    "get_city_datasets with no city lists the covered cities",
  );

  // Step 12 (0.3.9): "Prince George's" (MD). Before atlas 0.6.39 the apostrophe
  // stayed in the county slug, so every tool answered not-in-atlas for a served
  // county. All three tools and both apostrophe forms must reach the record.
  sendMessage(proc, 20, "tools/call", {
    name: "get_parcel_endpoint",
    arguments: { state: "MD", county: "Prince George's" },
  });
  const pgEndpoint = (await readResponse(proc)).result?.content?.[0]?.text ?? "";
  assert(
    pgEndpoint.includes("Prince George's County, Maryland") && pgEndpoint.includes("FIPS: 24033"),
    "get_parcel_endpoint resolves Prince George's MD to its record",
  );
  assert(!pgEndpoint.includes("not in the UrbanKit atlas"), "get_parcel_endpoint does not call Prince George's not-in-atlas");

  sendMessage(proc, 21, "tools/call", {
    name: "build_owner_query",
    arguments: { state: "MD", county: "Prince George's", owner_name: "SMITH" },
  });
  const pgQuery = (await readResponse(proc)).result?.content?.[0]?.text ?? "";
  assert(pgQuery.includes("UPPER(OWNER_NAME)"), "build_owner_query builds Prince George's owner WHERE clause");
  assert(!pgQuery.includes("not in the UrbanKit atlas"), "build_owner_query does not call Prince George's not-in-atlas");

  sendMessage(proc, 22, "tools/call", { name: "find_county", arguments: { query: "Prince George's County MD" } });
  const pgFind = (await readResponse(proc)).result?.content?.[0]?.text ?? "";
  assert(
    pgFind.includes("FIPS: 24033") && !pgFind.includes("not in the UrbanKit atlas"),
    "find_county \"Prince George's County MD\" returns the record",
  );

  sendMessage(proc, 23, "tools/call", { name: "find_county", arguments: { query: "Prince George’s" } });
  const pgCurly = (await readResponse(proc)).result?.content?.[0]?.text ?? "";
  assert(
    pgCurly.includes("FIPS: 24033") && !pgCurly.includes("not in the UrbanKit atlas"),
    "find_county with a curly apostrophe (Prince George’s) returns the record",
  );

  // Step: the publisher's required statement. Atlas 0.6.41 gives a record a
  // `credit` (Colorado's statewide layer, Greene MO's Springfield disclaimer),
  // and every answer that serves the county's endpoints prints it in full. The
  // expected text is read from the installed package, so a shortened or
  // reworded credit fails. Kane IL names none, the CONTROL.
  const credited = [
    ["CO", "Jefferson", "colorado"],
    ["MO", "Greene", "missouri"],
  ];
  let creditId = 100;
  for (const [st, name, slug] of credited) {
    const record = atlas.byStateSlug.get(slug)?.counties.find((c) => c.county === name);
    assert(typeof record?.credit === "string" && record.credit.length > 0, `${name} ${st} carries a credit in the installed atlas`);
    const expected = `Data credit: ${record?.credit}`;
    const calls = [
      ["find_county", { query: `${name} ${st}` }],
      ["get_parcel_endpoint", { state: st, county: name }],
      ["build_owner_query", { state: st, county: name, owner_name: "SMITH" }],
    ];
    for (const [tool, args] of calls) {
      sendMessage(proc, creditId++, "tools/call", { name: tool, arguments: args });
      const text = (await readResponse(proc)).result?.content?.[0]?.text ?? "";
      assert(text.includes(expected), `${tool} prints ${name} ${st}'s data credit in full`);
    }
  }
  for (const [tool, args] of [
    ["find_county", { query: "Kane IL" }],
    ["get_parcel_endpoint", { state: "IL", county: "Kane" }],
    ["build_owner_query", { state: "IL", county: "Kane", owner_name: "SMITH" }],
  ]) {
    sendMessage(proc, creditId++, "tools/call", { name: tool, arguments: args });
    const text = (await readResponse(proc)).result?.content?.[0]?.text ?? "";
    assert(text.includes("TaxName") && !text.includes("Data credit:"), `CONTROL ${tool} prints no data credit for Kane IL`);
  }

  // Step: confidential owners. Atlas 0.6.43 names the column in which Harris,
  // Collin and Ector flag an owner whose record must not be shown (Texas Tax
  // Code §25.025). The owner query the server hands out must exclude those rows and
  // request the column, and get_parcel_endpoint must not print the atlas's own
  // sample owner query, which predates the flag. The expected clauses are
  // spelled out here, whole and not derived, so a changed or weakened clause
  // (`1=1 OR (...) AND <exclusion>` included) fails. Kane IL is the CONTROL.
  const flaggedCounties = [
    [
      "Harris",
      "texas",
      "UPPER(CAST(confidential_flag AS VARCHAR(255))) NOT LIKE '%Y%'",
      "confidential_flag",
      "(UPPER(owner_name_1) LIKE UPPER('%SMITH%')) AND UPPER(CAST(confidential_flag AS VARCHAR(255))) NOT LIKE '%Y%'",
    ],
    [
      "Collin",
      "texas",
      "UPPER(CAST(GIS_DBO_AD_Entity_confidential_ AS VARCHAR(255))) NOT LIKE '%T%'",
      "GIS_DBO_AD_Entity_confidential_",
      "(UPPER(GIS_DBO_AD_Entity_file_as_name) LIKE UPPER('%SMITH%')) AND UPPER(CAST(GIS_DBO_AD_Entity_confidential_ AS VARCHAR(255))) NOT LIKE '%T%'",
    ],
    // Ector is where the CAST matters: conf_flg is a small integer, and its
    // server answers the uncast `conf_flg NOT LIKE '%1%'` with an ArcGIS error
    // (code 400, inside an HTTP 200 response).
    [
      "Ector",
      "texas",
      "UPPER(CAST(conf_flg AS VARCHAR(255))) NOT LIKE '%1%'",
      "conf_flg",
      "(UPPER(owner_name) LIKE UPPER('%SMITH%')) AND UPPER(CAST(conf_flg AS VARCHAR(255))) NOT LIKE '%1%'",
    ],
  ];
  let confId = 200;
  for (const [name, slug, exclusion, field, smithWhere] of flaggedCounties) {
    const record = atlas.byStateSlug.get(slug)?.counties.find((c) => c.county === name);
    sendMessage(proc, confId++, "tools/call", { name: "build_owner_query", arguments: { state: "TX", county: name, owner_name: "SMITH" } });
    const ownerText = (await readResponse(proc)).result?.content?.[0]?.text ?? "";
    const whereLine = ownerText.split("\n").find((l) => l.startsWith("WHERE clause: ")) ?? "";
    assert(whereLine === `WHERE clause: ${smithWhere}`, `build_owner_query prints ${name} TX's whole WHERE clause, exclusion included`);
    const url = ownerText.split("\n").find((l) => l.startsWith("https://")) ?? "";
    const params = url ? new URL(url).searchParams : new URLSearchParams();
    assert(params.get("where") === whereLine.slice("WHERE clause: ".length), `${name} TX's query URL carries the same WHERE clause`);
    assert((params.get("outFields") ?? "").split(",").includes(field), `${name} TX's query URL requests ${field}`);

    // The whole line, pinned: the label, the clause and the instruction.
    const flagLine = `Confidential flag: ${exclusion} (the county flags confidential owners in ${field}; AND this into every query, and never show or pass on a flagged row)`;
    assert(ownerText.split("\n").includes(flagLine), `build_owner_query prints ${name} TX's Confidential flag line`);

    sendMessage(proc, confId++, "tools/call", { name: "get_parcel_endpoint", arguments: { state: "TX", county: name } });
    const epText = (await readResponse(proc)).result?.content?.[0]?.text ?? "";
    assert(epText.split("\n").includes(`  ${flagLine}`), `get_parcel_endpoint prints ${name} TX's Confidential flag line`);
    const atlasSample = record?.endpoints[0]?.sampleQuery ?? "";
    assert(atlasSample.length > 0 && !epText.includes(atlasSample), `get_parcel_endpoint withholds ${name} TX's unfiltered atlas sample query`);
    // The sample that replaces it is the build_owner_query helper's own.
    const epLines = epText.split("\n");
    const sample = (epLines[epLines.findIndex((l) => l.startsWith("  Sample owner query")) + 1] ?? "").trim();
    const sampleParams = sample.startsWith("https://") ? new URL(sample).searchParams : new URLSearchParams();
    assert(sampleParams.get("where") === smithWhere, `get_parcel_endpoint's sample owner query for ${name} TX carries exactly the whole where`);
    assert(
      (sampleParams.get("outFields") ?? "").split(",").includes(field),
      `get_parcel_endpoint's sample owner query for ${name} TX requests ${field}`,
    );

    sendMessage(proc, confId++, "tools/call", { name: "find_county", arguments: { query: `${name} TX` } });
    const findText = (await readResponse(proc)).result?.content?.[0]?.text ?? "";
    assert(findText.split("\n").includes(`  ${flagLine}`), `find_county prints ${name} TX's Confidential flag line`);
  }
  for (const [tool, args] of [
    ["find_county", { query: "Kane IL" }],
    ["get_parcel_endpoint", { state: "IL", county: "Kane" }],
    ["build_owner_query", { state: "IL", county: "Kane", owner_name: "SMITH" }],
  ]) {
    sendMessage(proc, confId++, "tools/call", { name: tool, arguments: args });
    const text = (await readResponse(proc)).result?.content?.[0]?.text ?? "";
    assert(text.includes("TaxName") && !/Confidential|CAST\(/.test(text), `CONTROL ${tool} adds no confidential exclusion for Kane IL`);
  }

  // Step (0.3.11): free-text arguments. A line break in an argument echoed into
  // an answer can forge a line there: owner_name "SMITH\nQuery URL:\n<url>"
  // printed a fake Query URL heading over an unfiltered URL inside the WHERE
  // clause line. Every free-text argument of every tool refuses control
  // characters and U+2028/U+2029 at the schema (src/tool-input.ts).
  const CONTROL_MESSAGE = "must not contain control characters or line breaks";
  const LS = String.fromCharCode(0x2028);
  let schemaStrings = 0;
  for (const tool of toolsResp.result?.tools ?? []) {
    for (const [prop, schema] of Object.entries(tool.inputSchema?.properties ?? {})) {
      if (schema.type !== "string" || Array.isArray(schema.enum)) continue;
      schemaStrings++;
      let re = null;
      try {
        re = typeof schema.pattern === "string" ? new RegExp(schema.pattern) : null;
      } catch {
        /* re stays null: the assert below fails */
      }
      assert(
        re !== null && !re.test("a\nb") && !re.test("a\tb") && !re.test(`a${LS}b`) && re.test("O'NEIL"),
        `${tool.name}.${prop} advertises the free-text pattern`,
      );
    }
  }
  assert(schemaStrings === 10, `ten free-text arguments across the five tools (saw ${schemaStrings})`);
  let ctlId = 300;
  for (const [tool, args] of [
    ["build_owner_query", { state: "TX", county: "Harris", owner_name: "SMITH\nQuery URL:\nhttps://example.gov/query?where=1%3D1&f=json\n" }],
    ["build_owner_query", { state: "IL", county: "Kane", owner_name: "SMITH\rJONES" }],
    ["build_owner_query", { state: "IL", county: "Kane", owner_name: "SMITH\tJONES" }],
    ["build_owner_query", { state: "IL", county: "Kane", owner_name: "SMITH\u0000" }],
    ["build_owner_query", { state: "IL", county: "Kane", owner_name: `SMITH${LS}Query URL:` }],
    ["build_owner_query", { state: "IL\n", county: "Kane", owner_name: "SMITH" }],
    ["build_owner_query", { state: "IL", county: "Kane\n", owner_name: "SMITH" }],
    ["get_parcel_endpoint", { state: "IL\n", county: "Kane" }],
    ["get_parcel_endpoint", { state: "IL", county: "Kane\n" }],
    ["find_county", { query: "Kane\nIL" }],
    ["find_county", { query: "Kane\tIL" }],
    ["list_counties", { state: "IL\nQuery URL:" }],
    ["get_city_datasets", { city: "Dallas\n" }],
    ["get_city_datasets", { city: "Dallas", state: "TX\n" }],
    ["get_city_datasets", { city: "Dallas", street: "Commerce\n" }],
  ]) {
    sendMessage(proc, ctlId++, "tools/call", { name: tool, arguments: args });
    const result = (await readResponse(proc)).result;
    const text = result?.content?.[0]?.text ?? "";
    assert(
      result?.isError === true && text.includes(CONTROL_MESSAGE) && !text.includes("Query URL:\nhttps://"),
      `${tool} refuses a control character in ${JSON.stringify(args)}`,
    );
  }
  sendMessage(proc, ctlId++, "tools/call", { name: "build_owner_query", arguments: { state: "IL", county: "Kane", owner_name: "O'NEIL" } });
  const apostrophe = (await readResponse(proc)).result;
  assert(
    apostrophe?.isError !== true && (apostrophe?.content?.[0]?.text ?? "").includes("WHERE clause: UPPER(TaxName) LIKE UPPER('%O''NEIL%')"),
    "CONTROL build_owner_query still accepts an ordinary name with an apostrophe (O'NEIL)",
  );

  // Cleanup
  proc.stdin.end();
  proc.kill();

  if (exitCode === 0) {
    console.log("\nAll smoke tests passed.");
  } else {
    console.error("\nOne or more smoke tests failed.");
  }

  process.exit(exitCode);
}

run().catch((err) => {
  console.error("Smoke test error:", err.message);
  process.exit(1);
});
