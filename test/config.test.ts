import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test } from "vitest";

import { readConfig } from "../src/config.ts";

const cwd = process.cwd();
const valid = {
  $schema: "https://unpkg.com/orbitpush/schema.json",
  name: "site",
  outputDir: "dist",
  domain: "www.example.com",
  region: "DE",
  replicationRegions: ["NY"],
  geoZones: ["EU", "US"],
  storageZoneId: 1,
  pullZoneId: 2,
};

beforeEach(async () => {
  process.chdir(await mkdtemp(join(tmpdir(), "orbitpush-config-")));
});

afterEach(() => {
  process.chdir(cwd);
});

test("reads a valid orbitpush.json written before aliases existed", async () => {
  await writeFile("orbitpush.json", JSON.stringify(valid));

  const { $schema: _schema, ...expected } = valid;
  await expect(readConfig()).resolves.toEqual({ ...expected, aliases: [] });
});

test("tells the user to run init when orbitpush.json is missing", async () => {
  await expect(readConfig()).rejects.toThrow(
    "orbitpush.json not found. Run `orbitpush init` first.",
  );
});

test("reports an unreadable orbitpush.json as unreadable, not as missing", async () => {
  await mkdir("orbitpush.json");

  await expect(readConfig()).rejects.toMatchObject({ code: "EISDIR" });
});

test("reports malformed JSON as an invalid orbitpush.json", async () => {
  await writeFile("orbitpush.json", "{ name: ");

  await expect(readConfig()).rejects.toThrow(/^Invalid orbitpush\.json/);
});

test("names every invalid field", async () => {
  await writeFile(
    "orbitpush.json",
    JSON.stringify({ ...valid, region: "XX", geoZones: ["MARS"], pullZoneId: "2" }),
  );

  const message = await readConfig().then(
    () => "",
    (caught: unknown) => (caught instanceof Error ? caught.message : ""),
  );

  expect(message).toMatch(/^Invalid orbitpush\.json/);
  expect(message).toMatch(/region.*"DE"/);
  expect(message).toMatch(/geoZones/);
  expect(message).toMatch(/pullZoneId/);
  expect(message).not.toMatch(/outputDir/);
});

test("rejects an empty geoZones list, which would deliver the site nowhere", async () => {
  await writeFile("orbitpush.json", JSON.stringify({ ...valid, geoZones: [] }));

  await expect(readConfig()).rejects.toThrow(/geoZones/);
});

test("reads aliases next to the domain", async () => {
  await writeFile("orbitpush.json", JSON.stringify({ ...valid, aliases: ["example.com"] }));

  await expect(readConfig()).resolves.toMatchObject({ aliases: ["example.com"] });
});

test.each([
  ["without a domain to redirect to", { domain: undefined, aliases: ["example.com"] }],
  ["that repeat the domain", { domain: "www.example.com", aliases: ["WWW.example.com"] }],
])("rejects aliases %s", async (_, fields) => {
  await writeFile("orbitpush.json", JSON.stringify({ ...valid, ...fields }));

  await expect(readConfig()).rejects.toThrow(/aliases/);
});
