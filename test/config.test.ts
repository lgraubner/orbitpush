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

test("reads a valid orbitpush.json written before aliases, redirects and headers existed", async () => {
  await writeFile("orbitpush.json", JSON.stringify(valid));

  const { $schema: _schema, ...expected } = valid;
  await expect(readConfig()).resolves.toEqual({
    ...expected,
    aliases: [],
    redirects: [],
    headers: [],
  });
});

test("tells the user to run init when orbitpush.json is missing, also without a terminal", async () => {
  await expect(readConfig()).rejects.toThrow(/orbitpush\.json not found\. Run `orbitpush init`/);
  await expect(readConfig()).rejects.toThrow(/`orbitpush init --name <name> --dir <dir> --yes`/);
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
    JSON.stringify({
      ...valid,
      region: "XX",
      geoZones: ["MARS"],
      pullZoneId: "2",
      trailingSlash: "sometimes",
    }),
  );

  const message = await readConfig().then(
    () => "",
    (caught: unknown) => (caught instanceof Error ? caught.message : ""),
  );

  expect(message).toMatch(/^Invalid orbitpush\.json/);
  expect(message).toMatch(/region.*"DE"/);
  expect(message).toMatch(/geoZones/);
  expect(message).toMatch(/pullZoneId/);
  expect(message).toMatch(/trailingSlash/);
  expect(message).not.toMatch(/outputDir/);
});

test("rejects an empty geoZones list, which would deliver the site nowhere", async () => {
  await writeFile("orbitpush.json", JSON.stringify({ ...valid, geoZones: [] }));

  await expect(readConfig()).rejects.toThrow(/geoZones/);
});

test("reads 8 aliases, the most bunny.net's 10 hostnames per pull zone leave room for", async () => {
  const aliases = Array.from({ length: 8 }, (_, i) => `a${i}.example.com`);
  await writeFile(
    "orbitpush.json",
    JSON.stringify({ ...valid, domain: "www.example.com", aliases }),
  );

  await expect(readConfig()).resolves.toMatchObject({ aliases });
});

test("reads aliases next to the domain", async () => {
  await writeFile("orbitpush.json", JSON.stringify({ ...valid, aliases: ["example.com"] }));

  await expect(readConfig()).resolves.toMatchObject({
    aliases: ["example.com"],
  });
});

test.each([
  ["without a domain to redirect to", { domain: undefined, aliases: ["example.com"] }],
  ["that repeat the domain", { domain: "www.example.com", aliases: ["WWW.example.com"] }],
  [
    "beyond the 8 that fit into bunny.net's 10 hostnames per pull zone",
    {
      domain: "www.example.com",
      aliases: Array.from({ length: 9 }, (_, i) => `a${i}.example.com`),
    },
  ],
])("rejects aliases %s", async (_, fields) => {
  await writeFile("orbitpush.json", JSON.stringify({ ...valid, ...fields }));

  await expect(readConfig()).rejects.toThrow(/aliases/);
});

test.each([
  ["domain", { domain: "https://www.example.com" }],
  ["aliases", { aliases: ["example.com/"] }],
])("rejects a value in %s that is not a hostname", async (field, fields) => {
  await writeFile("orbitpush.json", JSON.stringify({ ...valid, ...fields }));

  await expect(readConfig()).rejects.toThrow(new RegExp(`${field}.*hostname`));
});

test("reads redirects and headers in the shape of netlify.toml, with status defaulting to 301", async () => {
  const redirects = [
    { from: "/old", to: "/new" },
    {
      from: "/de/*",
      to: "/de/:splat",
      status: 302,
      force: true,
      query: { id: ":id" },
      conditions: { Country: ["de", "at"] },
    },
  ];
  const headers = [{ for: "/*", values: { "X-Frame-Options": "DENY" } }];
  await writeFile("orbitpush.json", JSON.stringify({ ...valid, redirects, headers }));

  await expect(readConfig()).resolves.toMatchObject({
    redirects: [{ from: "/old", to: "/new", status: 301 }, redirects[1]],
    headers,
  });
});

test("accepts well-formed redirects that deploy cannot apply", async () => {
  const redirects = [
    { from: "/en/*", to: "/en/:splat", conditions: { Language: ["en"] } },
    { from: "/app/*", to: "/index.html", status: 200 },
  ];
  await writeFile("orbitpush.json", JSON.stringify({ ...valid, redirects }));

  await expect(readConfig()).resolves.toMatchObject({ redirects });
});

test.each([
  [
    "a misspelled key",
    /redirects\.0\b.*stauts/,
    { redirects: [{ from: "/a", to: "/b", stauts: 302 }] },
  ],
  ["signed", /redirects\.0\b.*signed/, { redirects: [{ from: "/a", to: "/b", signed: "SECRET" }] }],
  ["a missing to", /redirects\.0\.to/, { redirects: [{ from: "/a" }] }],
  [
    "a string status",
    /redirects\.0\.status/,
    { redirects: [{ from: "/a", to: "/b", status: "301" }] },
  ],
  [
    "a fractional status",
    /redirects\.0\.status/,
    { redirects: [{ from: "/a", to: "/b", status: 301.5 }] },
  ],
  [
    "an empty condition list",
    /redirects\.0\.conditions/,
    { redirects: [{ from: "/a", to: "/b", conditions: { Country: [] } }] },
  ],
  [
    "a header value that is not a string",
    /headers\.1\.values/,
    {
      headers: [
        { for: "/*", values: {} },
        { for: "/a", values: { "Cache-Control": ["no-cache"] } },
      ],
    },
  ],
  ["missing header values", /headers\.0\.values/, { headers: [{ for: "/*" }] }],
  [
    "an unknown header key",
    /headers\.0\b.*source/,
    { headers: [{ for: "/*", values: {}, source: "/a" }] },
  ],
])("rejects %s and names its path", async (_, path, fields) => {
  await writeFile("orbitpush.json", JSON.stringify({ ...valid, ...fields }));

  await expect(readConfig()).rejects.toThrow(/^Invalid orbitpush\.json/);
  await expect(readConfig()).rejects.toThrow(path);
});
