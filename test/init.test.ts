import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { init } from "../src/init.ts";

const cwd = process.cwd();
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbitpush-init-"));
  process.chdir(dir);
  vi.stubEnv("BUNNY_API_KEY", "key");
});

afterEach(async () => {
  process.chdir(cwd);
  await chmod(dir, 0o755);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function fakeBunny({ pullZoneTaken = false } = {}) {
  const writes: string[] = [];
  const bodies: Record<string, unknown> = {};

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = input instanceof Request ? input.url : input.toString();
    const method = init.method ?? "GET";
    const json = (value: unknown) => new Response(JSON.stringify(value));

    if (method !== "GET") writes.push(`${method} ${url}`);
    if (typeof init.body === "string") bodies[`${method} ${url}`] = JSON.parse(init.body);
    if (url === "https://api.bunny.net/storagezone" && method === "POST") return json({ Id: 1 });
    if (url === "https://api.bunny.net/pullzone" && method === "POST") {
      return pullZoneTaken
        ? new Response(JSON.stringify({ Message: "name taken" }), { status: 400 })
        : json({ Id: 2 });
    }

    if (url === "https://api.bunny.net/pullzone/2") {
      return json({ Id: 2, Name: "site", Hostnames: [], EdgeRules: [] });
    }

    return new Response(null, { status: 204 });
  });

  return { writes, bodies };
}

test("init creates both zones and writes orbitpush.json", async () => {
  const { writes } = fakeBunny();

  await init({ name: "site", yes: true }, false);

  expect(writes).toEqual([
    "POST https://api.bunny.net/storagezone",
    "POST https://api.bunny.net/pullzone",
  ]);
  const written: unknown = JSON.parse(await readFile("orbitpush.json", "utf8"));

  expect(written).toMatchObject({
    storageZoneId: 1,
    pullZoneId: 2,
  });
});

test("init deletes both zones when orbitpush.json cannot be written", async () => {
  const { writes } = fakeBunny();
  await chmod(dir, 0o555);

  await expect(init({ name: "site", yes: true }, false)).rejects.toMatchObject({ code: "EACCES" });
  expect(writes).toEqual([
    "POST https://api.bunny.net/storagezone",
    "POST https://api.bunny.net/pullzone",
    "DELETE https://api.bunny.net/pullzone/2",
    "DELETE https://api.bunny.net/storagezone/1",
  ]);
});

test("init deletes the storage zone when the pull zone cannot be created", async () => {
  const { writes } = fakeBunny({ pullZoneTaken: true });

  await expect(init({ name: "site", yes: true }, false)).rejects.toThrow();
  expect(writes).toEqual([
    "POST https://api.bunny.net/storagezone",
    "POST https://api.bunny.net/pullzone",
    "DELETE https://api.bunny.net/storagezone/1",
  ]);
});

test("init creates the storage zone with the chosen name and regions", async () => {
  const { bodies } = fakeBunny();

  await init({ name: "site", region: "ny", yes: true }, false);

  const written = JSON.parse(await readFile("orbitpush.json", "utf8")) as Record<string, unknown>;
  expect(written.region).toBe("NY");
  expect(bodies["POST https://api.bunny.net/storagezone"]).toMatchObject({
    Name: "site",
    Region: "NY",
    ReplicationRegions: written.replicationRegions,
  });
});

test("init creates the pull zone on the new storage zone with the default delivery regions", async () => {
  const { bodies } = fakeBunny();

  await init({ name: "site", yes: true }, false);

  const written = JSON.parse(await readFile("orbitpush.json", "utf8")) as Record<string, unknown>;
  expect(written.geoZones).toEqual(["EU", "US"]);
  expect(bodies["POST https://api.bunny.net/pullzone"]).toMatchObject({
    Name: "site",
    OriginType: 2,
    StorageZoneId: 1,
    EnableGeoZoneEU: true,
    EnableGeoZoneUS: true,
    EnableGeoZoneASIA: false,
    EnableGeoZoneSA: false,
    EnableGeoZoneAF: false,
  });
});

test("init refuses to run when orbitpush.json exists and sends nothing to bunny.net", async () => {
  fakeBunny();
  await writeFile("orbitpush.json", "keep me");

  await expect(init({ name: "site", yes: true }, false)).rejects.toThrow(/orbitpush\.json/);
  expect(fetch).not.toHaveBeenCalled();
  expect(await readFile("orbitpush.json", "utf8")).toBe("keep me");
});

test("init writes the domain and its aliases and adds them all to the pull zone", async () => {
  const { writes, bodies } = fakeBunny();

  await init({ name: "site", domain: "www.example.com", alias: ["example.com"], yes: true }, false);

  const written: unknown = JSON.parse(await readFile("orbitpush.json", "utf8"));
  expect(written).toMatchObject({ domain: "www.example.com", aliases: ["example.com"] });
  const added = writes.filter((w) => w.endsWith("/addHostname"));
  expect(added).toHaveLength(2);
  expect(bodies["POST https://api.bunny.net/pullzone/2/addHostname"]).toEqual({
    Hostname: "example.com",
  });
});

test("init writes no domain key without a custom domain", async () => {
  fakeBunny();

  await init({ name: "site", yes: true }, false);

  const written = JSON.parse(await readFile("orbitpush.json", "utf8")) as Record<string, unknown>;
  expect(written).not.toHaveProperty("domain");
  expect(written).toMatchObject({ aliases: [] });
});

test.each([
  ["without a domain", { alias: ["example.com"] }],
  ["that repeats the domain", { domain: "www.example.com", alias: ["WWW.example.com"] }],
  [
    "beyond the 8 that fit next to b-cdn.net and the domain in bunny.net's 10 hostnames",
    { domain: "www.example.com", alias: Array.from({ length: 9 }, (_, i) => `a${i}.example.com`) },
  ],
])("init rejects an alias %s before sending anything to bunny.net", async (_, flags) => {
  const { writes } = fakeBunny();

  await expect(init({ name: "site", yes: true, ...flags }, false)).rejects.toThrow(/alias/i);
  expect(writes).toEqual([]);
});
