/**
 * Fixture records for test/owner-join.test.mjs, shaped like the first county
 * the atlas registers with an owner table (Sussex County DE, atlas 0.9.1): the
 * parcel polygons on layer 0 keyed on `Name`, which is the PIN, and the owners
 * in table 1 keyed on `PIN`, one or more rows per parcel.
 *
 * The host is a made-up one on purpose. Nothing here is ever fetched, and a
 * fixture URL must not be a county's real server. The county is named
 * "Sussex Fixture" so it can never be taken for the atlas's own record, in
 * this file or in a server the preload adds it to.
 */
import { countySlugFromName } from "@urbankitstudio/atlas";

const SERVICE = "https://gis.example.gov/server/rest/services/County_Layers/Parcels_PIN/MapServer";
export const LAYER_URL = `${SERVICE}/0`;
export const TABLE_URL = `${SERVICE}/1`;

/** The owner table: key, row label, two owner names and a split mailing address. */
export function ownerTable(overrides = {}) {
  return {
    url: TABLE_URL,
    layerName: "OwnershipInformation",
    key: "PIN",
    parcelKey: "Name",
    fields: [
      { name: "PIN", label: "PIN", searchable: true },
      { name: "PINWASSEMENTUNIT", label: "PIN with assessment unit", searchable: true },
      { name: "FULLNAME", label: "Owner Name", searchable: true },
      { name: "Second_Owner_Name", label: "Second Owner Name", searchable: true },
      { name: "MAILINGADDRESS", label: "Mailing Address", searchable: true },
      { name: "CITY", label: "Mailing City", searchable: true },
      { name: "STATE", label: "Mailing State", searchable: true },
      { name: "ZIPCODE", label: "Mailing Zip", searchable: true },
    ],
    rowIdField: "PINWASSEMENTUNIT",
    multiple: "rows",
    maxRowsPerKey: 3,
    orderField: "OBJECTID_1",
    maxRecordCount: 1000,
    lastVerified: "2026-11-10",
    ...overrides,
  };
}

/** The parcel layer: a parcel id and nothing that reads as an owner or a mailing column. */
export function joinedEndpoint(overrides = {}) {
  return {
    url: LAYER_URL,
    serviceType: "MapServer",
    layerIndex: 0,
    layerName: "Tax Parcels",
    supportsQuery: true,
    corsEnabled: true,
    searchFields: [{ name: "Name", label: "PIN", searchable: true }],
    ownerJoin: ownerTable(),
    sampleQuery: `${LAYER_URL}/query?where=Name%3D'1-23-4.00-5.00'&outFields=Name&returnGeometry=false&f=json`,
    license: "public",
    licenseUrl: null,
    status: "live",
    lastVerified: "2026-11-10",
    verifiedBy: "manual",
    ...overrides,
  };
}

/** The same layer with no owner table: what a reader that ignores the join sees. */
export function plainEndpoint(overrides = {}) {
  const { ownerJoin, ...plain } = joinedEndpoint(overrides);
  return plain;
}

/** A whole county record around one endpoint, complete enough for the server's tools. */
export function fixtureCounty(name, endpoint, fips) {
  return {
    id: `de-${countySlugFromName(name)}`,
    state: "DE",
    stateName: "Delaware",
    stateSlug: "delaware",
    county: name,
    countySlug: countySlugFromName(name),
    countyFips: fips,
    hasPublicRest: true,
    endpoints: [endpoint],
    contact: { department: "Fixture", url: null, email: null },
    notes: "",
  };
}

export const JOINED_COUNTY_NAME = "Sussex Fixture";
export const WIRE_COUNTY_NAME = "Wire Fixture";
export const WIRE_LAYER_URL = "https://gis.example.gov/server/rest/services/Joined/MapServer/7";

export const ROLE_COUNTY_NAME = "Role Fixture";
export const ROLE_LAYER_URL = "https://gis.example.gov/server/rest/services/Roles/FeatureServer/0";

/**
 * A layer shaped like Dooly County GA (atlas 0.9.7): a composite site address
 * with its directional in a column of its own, and a mailing column with a
 * second line declared as its fallback. Both columns are searchable: false and
 * carry a `role`, in the order Dooly lists them (directional first).
 */
export function roleEndpoint() {
  return plainEndpoint({
    url: ROLE_LAYER_URL,
    serviceType: "FeatureServer",
    layerIndex: 0,
    searchFields: [
      { name: "Parcel_No", label: "Parcel ID", searchable: true },
      { name: "lastname", label: "Owner Name", searchable: true },
      { name: "house_no", label: "House Number", searchable: true },
      { name: "street_nam", label: "Street Name", searchable: true },
      { name: "stdirect", label: "Street Direction", searchable: false, role: "situs-directional" },
      { name: "address2", label: "Owner Mailing Address", searchable: true },
      { name: "address1", label: "Owner Mailing Line 1 (c/o or street)", searchable: false, role: "mailing-fallback" },
    ],
    sampleQuery: null,
  });
}

/** A layer that answers with qualified column names and carries no owner table. */
export function wireEndpoint() {
  return plainEndpoint({
    url: WIRE_LAYER_URL,
    layerIndex: 7,
    searchFields: [
      { name: "TAXPINNO", label: "Parcel ID", searchable: true, wireName: "SDE.mc_parcel_polygon.TAXPINNO" },
      { name: "OWNER_NAME1", label: "Owner Name", searchable: true, wireName: "SDE.WEB_CAMA.OWNER_NAME1" },
    ],
    sampleQuery: null,
  });
}
