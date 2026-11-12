/**
 * Preload for test/owner-join.test.mjs: `node --import <this file> dist/server.js`.
 *
 * The bundled atlas carries no owner-table record yet, and the server reads its
 * counties from the atlas package only. This adds two fixture counties to the
 * package's in-memory Delaware file before the server starts, so the built
 * server's own tool handlers can be driven over stdio against a joined record.
 * The server imports the same module instance, so it sees them. Nothing is
 * written to disk and nothing is fetched.
 */
import { atlas } from "@urbankitstudio/atlas";
import {
  fixtureCounty,
  joinedEndpoint,
  wireEndpoint,
  JOINED_COUNTY_NAME,
  WIRE_COUNTY_NAME,
} from "./owner-join-fixture.mjs";

const delaware = atlas.byStateSlug.get("delaware");
if (!delaware) throw new Error("owner-join-preload: the installed atlas has no Delaware file to add the fixtures to");
delaware.counties.push(
  fixtureCounty(JOINED_COUNTY_NAME, joinedEndpoint(), "10991"),
  fixtureCounty(WIRE_COUNTY_NAME, wireEndpoint(), "10992"),
);
