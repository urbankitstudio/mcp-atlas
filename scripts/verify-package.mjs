/**
 * The one gate both workflows call, run against the EXTRACTED TARBALL.
 *
 * WHY A SCRIPT RATHER THAN STEPS IN EACH WORKFLOW. ci.yml and publish.yml both
 * trigger on a push to main with no `needs:` between them, so ci.yml going red
 * cannot stop a release. When the two files carried their own copies of the
 * package checks they drifted, and the only gate that could actually block a
 * publish was the weaker one. One implementation, two callers, so they cannot
 * drift again.
 *
 * WHY THE TARBALL AND NOT THE WORKING TREE. `files` in package.json decides what
 * ships. The working tree is not the package, and every check here is about what
 * a user would actually install.
 *
 * Everything is asserted in JS rather than shell on purpose. The shell idioms
 * this replaces fail OPEN: `node -p "require('./x.json').a.b"` on a missing
 * field prints the string "undefined" and exits 0 rather than throwing, and
 * `[ "undefined" -lt 100 ]` then errors with "integer expected" -- which, inside
 * an `if A || B`, is just a false clause. The check passes and reports nothing.
 *
 * Usage: node scripts/verify-package.mjs <extracted-package-dir> [repo-dir]
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, isAbsolute, resolve, relative, sep } from "node:path";

const packageDir = process.argv[2];
const repoDir = process.argv[3] ?? process.cwd();

if (!packageDir) {
  console.error("::error::usage: verify-package.mjs <extracted-package-dir> [repo-dir]");
  process.exit(2);
}

const problems = [];
const note = (msg) => console.log(`ok  ${msg}`);
const bad = (msg) => {
  problems.push(msg);
  console.log(`::error::${msg}`);
};

const readJson = (path, label) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    bad(`${label} could not be read as JSON (${path}): ${err.message}`);
    return null;
  }
};

const pkg = readJson(join(packageDir, "package.json"), "the packaged package.json");
if (!pkg) {
  console.log("\nverify-package: FAILED before it could start");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. Entry points. The `bin` entry is the whole product -- an MCP client
//    launches the package by that path -- so a package that installs and does
//    nothing is the failure this catches. An absolute path is checked as well
//    as a missing one: `main: "/etc/passwd"` would make `existsSync` true on the
//    runner while shipping something that resolves nowhere on a user's machine.
// ---------------------------------------------------------------------------
const entryPoints = [
  ...Object.entries(pkg.bin ?? {}).map(([name, value]) => [`bin.${name}`, value]),
  ["main", pkg.main],
  ["types", pkg.types],
].filter(([, value]) => value !== undefined);

if (entryPoints.length === 0) {
  bad("package.json declares no bin, main or types at all");
}

for (const [field, value] of entryPoints) {
  if (typeof value !== "string" || value.length === 0) {
    bad(`${field} is not a non-empty string`);
    continue;
  }
  if (isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    bad(`${field} is an absolute path ("${value}"); it must be relative to the package`);
    continue;
  }
  const target = resolve(packageDir, value);
  const inside = relative(packageDir, target);
  if (inside.startsWith("..") || inside.split(sep).includes("..")) {
    bad(`${field} ("${value}") resolves outside the package`);
    continue;
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    bad(`${field} points at "${value}", which is not in the package`);
    continue;
  }
  note(`${field} -> ${value}`);
}

// ---------------------------------------------------------------------------
// 2. Publish-time lifecycle scripts, on an allow-list.
//
//    `npm pack` and `npm publish` build SEPARATE archives, and `prepublishOnly`
//    runs only on publish -- so the bytes verified here are not literally the
//    bytes that ship. Publishing the packed tarball instead would close that
//    gap, but npm's own docs do not state whether provenance survives a
//    pre-packed tarball publish, and provenance is the entire reason this
//    package publishes from a public repo. Trading it away to fix a lower-tier
//    risk is a bad bargain, so the mechanism is blocked instead of the symptom:
//    a script that could rewrite dist/ between pack and publish cannot be added
//    without this list being edited in the same PR.
// ---------------------------------------------------------------------------
const ALLOWED_LIFECYCLE = new Map([
  ["prepublishOnly", "npm run typecheck && npm run build && npm run smoke"],
]);

const LIFECYCLE_NAMES = [
  "preinstall", "install", "postinstall",
  "prepare", "prepack", "postpack",
  "prepublish", "prepublishOnly", "publish", "postpublish",
];

for (const name of LIFECYCLE_NAMES) {
  const script = pkg.scripts?.[name];
  if (script === undefined) continue;
  if (!ALLOWED_LIFECYCLE.has(name)) {
    bad(`${name} is not an allowed publish-time lifecycle script. It runs automatically around publish; add it to ALLOWED_LIFECYCLE in this file if it is intended.`);
    continue;
  }
  const expected = ALLOWED_LIFECYCLE.get(name);
  if (script !== expected) {
    bad(`${name} is not the expected script.\n  expected: ${expected}\n  found:    ${script}`);
    continue;
  }
  note(`${name} is the expected script`);
}

// ---------------------------------------------------------------------------
// 3. The coverage this package advertises matches the atlas it actually
//    resolves.
//
//    🔴 THIS IS THE CHECK THAT WOULD HAVE CAUGHT THE REAL DRIFT. On 2026-09-21
//    the README, package.json and server.json all advertised 227 counties / 241
//    layers while package-lock.json pinned @urbankitstudio/atlas 0.6.2, which
//    holds 171 counties / 174 endpoints. Users were fine -- no lockfile ships in
//    the tarball, so `^0.6.2` resolved to 0.6.5 on install -- but this repo's own
//    CI had been smoke-testing the server against a dataset a third smaller than
//    the one it ships against, and nothing said so.
//
//    The atlas data is read from the REPO's node_modules, not the tarball: the
//    package declares atlas as a runtime dependency rather than bundling it, so
//    the resolved dependency IS the coverage a user gets.
// ---------------------------------------------------------------------------
const atlasPkgPath = join(repoDir, "node_modules", "@urbankitstudio", "atlas", "package.json");
const atlasIndexPath = join(repoDir, "node_modules", "@urbankitstudio", "atlas", "data", "index.json");

if (!existsSync(atlasIndexPath)) {
  bad(`the atlas dependency is not installed at ${atlasIndexPath}; run npm ci before this script. Refusing to skip the coverage check.`);
} else {
  const atlasPkg = readJson(atlasPkgPath, "the atlas package.json");
  const atlasIndex = readJson(atlasIndexPath, "the atlas data index");

  if (atlasIndex) {
    const totals = atlasIndex.totals ?? {};
    // Integers BEFORE any comparison. A missing field must not become the
    // string "undefined" and slide through a numeric test.
    const TOTALS = {};
    for (const key of ["states", "counties", "endpoints"]) {
      const value = totals[key];
      if (!Number.isInteger(value)) {
        bad(`atlas data totals.${key} is not an integer (got ${JSON.stringify(value)})`);
      } else {
        TOTALS[key] = value;
      }
    }

    // A floor, not an exact count: the registry grows, so pinning the number
    // would fail on every real atlas release. This only has to catch a
    // truncated or empty atlas.
    if (Number.isInteger(TOTALS.counties) && TOTALS.counties < 100) {
      bad(`the resolved atlas carries only ${TOTALS.counties} counties, which looks truncated`);
    }

    if (Object.keys(TOTALS).length === 3) {
      note(`resolved @urbankitstudio/atlas ${atlasPkg?.version ?? "?"}: ${TOTALS.counties} counties, ${TOTALS.endpoints} endpoints, ${TOTALS.states} states`);

      // Each pattern names the number it is about. The captured value must
      // equal the live total.
      const PATTERNS = {
        counties: { re: () => /(\d[\d,]*)\s+(?:verified\s+)?(?:US\s+)?counties/gi, total: "counties" },
        states: { re: () => /(\d[\d,]*)\s+US\s+states/gi, total: "states" },
        endpoints: { re: () => /(\d[\d,]*)\s+(?:verified\s+)?(?:ArcGIS\s+)?(?:layers|endpoints)/gi, total: "endpoints" },
      };

      const serverJson = readJson(join(repoDir, "server.json"), "server.json");

      // server.json does not ship in the tarball (`files` does not list it) but
      // the MCP registry reads it from this repo, so its claims rot the same way
      // and belong in the same check.
      const SITES = [
        { name: "the packaged package.json description", text: pkg.description, require: ["counties", "states", "endpoints"] },
        { name: "the packaged README.md", text: existsSync(join(packageDir, "README.md")) ? readFileSync(join(packageDir, "README.md"), "utf8") : undefined, require: ["counties", "states", "endpoints"] },
        { name: "server.json description", text: serverJson?.description, require: ["counties", "endpoints"] },
      ];

      for (const site of SITES) {
        if (typeof site.text !== "string" || site.text.length === 0) {
          bad(`${site.name} is missing or empty, so its coverage claims cannot be checked`);
          continue;
        }
        for (const key of site.require) {
          const { re, total } = PATTERNS[key];
          const matches = [...site.text.matchAll(re())];
          // 🔴 THE ANTI-VACUITY HALF, and the more important one. A regex that
          // matches NOTHING passes every comparison it never makes. If someone
          // rewords a claim so this stops reading it, that must be a loud
          // failure here rather than a check that quietly retires itself.
          if (matches.length === 0) {
            bad(`${site.name} states no ${key} count this check can read. Either the coverage claim was removed, or it was reworded past the pattern in verify-package.mjs -- fix whichever is wrong, do not leave the claim unchecked.`);
            continue;
          }
          for (const match of matches) {
            const claimed = Number(match[1].replace(/,/g, ""));
            if (claimed !== TOTALS[total]) {
              bad(`${site.name} claims ${match[0].trim()}, but the resolved atlas has ${TOTALS[total]} ${total}`);
            }
          }
          note(`${site.name}: ${key} claim agrees (${matches.length} mention${matches.length === 1 ? "" : "s"})`);
        }
      }

      // Two claims this repo AUTHORS about which atlas it targets: the range
      // floor in package.json and the version the README names. They are both
      // hand-written, so they must agree with each other. The resolved version
      // is deliberately not required to equal them -- a caret range is meant to
      // pick up later atlas patches, and if one of those changes the counts the
      // parity check above is what catches it.
      const declaredRange = pkg.dependencies?.["@urbankitstudio/atlas"];
      const readmePath = join(packageDir, "README.md");
      const readmeText = existsSync(readmePath) ? readFileSync(readmePath, "utf8") : "";
      const floor = typeof declaredRange === "string" ? declaredRange.match(/(\d+\.\d+\.\d+)/)?.[1] : undefined;
      const readmeAtlas = readmeText.match(/atlas\s+(\d+\.\d+\.\d+)/i)?.[1];

      if (!floor) {
        bad(`package.json does not declare a @urbankitstudio/atlas version range this check can read (got ${JSON.stringify(declaredRange)})`);
      } else if (!readmeAtlas) {
        bad("README.md does not name the atlas version it was written against (expected something like \"(atlas 0.6.5)\")");
      } else if (floor !== readmeAtlas) {
        bad(`README.md says it was written against atlas ${readmeAtlas}, but package.json's range floor is ${floor}. One of them is stale.`);
      } else {
        note(`atlas version claims agree: range floor ${floor} = README ${readmeAtlas}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 4. mcpName, read from the PACKAGED package.json.
//
//    The MCP registry proves npm ownership by reading `mcpName` out of the
//    published package and comparing it with server.json's name. A package
//    without it publishes fine on npm and is then refused by the registry --
//    which is how 0.1.6 through 0.2.2 all shipped unlistable. Checking the
//    tarball rather than the working tree is the point: the registry reads what
//    shipped.
// ---------------------------------------------------------------------------
const serverForName = readJson(join(repoDir, "server.json"), "server.json");
if (serverForName) {
  if (pkg.mcpName !== serverForName.name) {
    bad(`the packaged package.json has mcpName ${JSON.stringify(pkg.mcpName)} but server.json's name is ${JSON.stringify(serverForName.name)}. The registry rejects the npm package unless they match.`);
  } else {
    note(`mcpName matches server.json: ${pkg.mcpName}`);
  }
}

console.log("");
if (problems.length > 0) {
  console.log(`verify-package: ${problems.length} problem${problems.length === 1 ? "" : "s"} -- REFUSING`);
  process.exit(1);
}
console.log(`verify-package: ${pkg.name}@${pkg.version} is fit to publish`);
