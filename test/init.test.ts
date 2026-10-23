import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { init } from "../src/init.ts";

type Prompt = {
  message: string;
  default?: unknown;
  choices?: (string | { value: unknown; checked?: boolean })[];
};

const asked: string[] = [];
const value = (choice: string | { value: unknown }) =>
  typeof choice === "string" ? choice : choice.value;

// Answers every prompt with its default, so an interactive init runs without a terminal
vi.mock("@inquirer/prompts", () => {
  const answer = (fallback: (p: Prompt) => unknown) => async (p: Prompt) => {
    asked.push(p.message);
    return p.default ?? fallback(p);
  };

  return {
    input: answer(() => "dist"),
    password: answer(() => "key"),
    confirm: answer(() => true),
    select: answer((p) => value(p.choices?.[0] ?? "")),
    checkbox: answer((p) =>
      (p.choices ?? []).filter((c) => typeof c !== "string" && c.checked).map(value),
    ),
  };
});

const cwd = process.cwd();
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbitpush-init-"));
  process.chdir(dir);
  asked.length = 0;
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

test.each([
  ["with a space", "my site"],
  ["with a dot", "my.site"],
  ["that is empty", ""],
])("init rejects a name %s before sending anything to bunny.net", async (_, name) => {
  const { writes } = fakeBunny();

  await expect(init({ name, yes: true }, false)).rejects.toThrow(/name/i);
  expect(writes).toEqual([]);
});

test.each([
  ["a domain with a scheme", { domain: "https://www.example.com" }],
  ["a domain with a path", { domain: "www.example.com/" }],
  ["an alias with a port", { domain: "www.example.com", alias: ["example.com:8080"] }],
])("init rejects %s before sending anything to bunny.net", async (_, flags) => {
  const { writes } = fakeBunny();

  await expect(init({ name: "site", yes: true, ...flags }, false)).rejects.toThrow(/hostname/);
  expect(writes).toEqual([]);
});

test("init sends the replication and delivery regions from their flags and writes them", async () => {
  const { bodies } = fakeBunny();

  await init(
    {
      name: "site",
      "replication-region": ["ny", "SG"],
      "delivery-region": "asia,eu",
      yes: true,
    },
    false,
  );

  const written = JSON.parse(await readFile("orbitpush.json", "utf8")) as Record<string, unknown>;
  expect(written).toMatchObject({ replicationRegions: ["NY", "SG"], geoZones: ["ASIA", "EU"] });
  expect(bodies["POST https://api.bunny.net/storagezone"]).toMatchObject({
    ReplicationRegions: ["NY", "SG"],
  });
  expect(bodies["POST https://api.bunny.net/pullzone"]).toMatchObject({
    EnableGeoZoneASIA: true,
    EnableGeoZoneEU: true,
    EnableGeoZoneUS: false,
    EnableGeoZoneSA: false,
    EnableGeoZoneAF: false,
  });
});

test.each([
  ["an unknown replication region", { "replication-region": "MARS" }, /--replication-region/],
  ["the main region as a replication region", { "replication-region": "de" }, /main region/],
  ["an unknown delivery region", { "delivery-region": "EU,MOON" }, /--delivery-region/],
  ["an empty delivery region list", { "delivery-region": "" }, /--delivery-region/],
])("init rejects %s before sending anything to bunny.net", async (_, flags, message) => {
  const { writes } = fakeBunny();

  await expect(init({ name: "site", yes: true, ...flags }, false)).rejects.toThrow(message);
  expect(writes).toEqual([]);
});

test.each([
  ["without --name and --dir", {}],
  ["with only --name", { name: "site" }],
  ["with only --dir", { dir: "dist" }],
])("init without a terminal %s stops before sending anything to bunny.net", async (_, flags) => {
  fakeBunny();

  const error = await init(flags, false).catch((e: unknown) => e);

  expect(String(error)).toMatch(
    new RegExp(
      `Without a terminal, init needs --name and --dir, or --yes for the defaults \\(name ${basename(dir).toLowerCase()}, dir \\S+\\)`,
    ),
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(existsSync("orbitpush.json")).toBe(false);
});

test.each([
  ["--yes", { yes: true }],
  ["--name and --dir", { name: "site", dir: "dist" }],
])("init without a terminal creates both zones with %s", async (_, flags) => {
  const { writes } = fakeBunny();

  await init(flags, false);

  expect(writes).toEqual([
    "POST https://api.bunny.net/storagezone",
    "POST https://api.bunny.net/pullzone",
  ]);
});

test("init in a terminal asks no domain or alias question", async () => {
  const { writes } = fakeBunny();
  vi.spyOn(process.stderr, "write").mockReturnValue(true);

  await init({}, true);

  expect(asked.length).toBeGreaterThan(0);
  expect(asked.filter((message) => /domain|Aliases/.test(message))).toEqual([]);
  expect(writes).toEqual([
    "POST https://api.bunny.net/storagezone",
    "POST https://api.bunny.net/pullzone",
  ]);
});

test("init in a terminal still takes --domain and --alias", async () => {
  const { writes } = fakeBunny();
  vi.spyOn(process.stderr, "write").mockReturnValue(true);

  await init({ domain: "www.example.com", alias: "example.com" }, true);

  expect(writes.filter((w) => w.endsWith("/addHostname"))).toHaveLength(2);
});

test.each([
  [{}, "2. Use your own domain: `npx orbitpush domains add www.example.com`"],
  [
    { domain: "www.example.com" },
    "2. Add the DNS records above, then run `npx orbitpush domains add www.example.com`",
  ],
])("init with %o prints the next steps", async (flags, second) => {
  fakeBunny();
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  await init({ name: "site", dir: "dist", ...flags }, false);

  const output = stripVTControlCharacters(stderr.mock.calls.join(""));
  const next = output.indexOf("Next:");
  const first = output.indexOf("1. Build your site, then run `npx orbitpush deploy`");
  expect(next).toBeGreaterThan(-1);
  expect(first).toBeGreaterThan(next);
  expect(output.indexOf(second)).toBeGreaterThan(first);
});

test.each([
  ["an invalid --domain", { domain: "https://www.example.com" }, /hostname/],
  ["an --alias without --domain", { alias: "example.com" }, /alias/i],
])("init without a terminal or --yes rejects %s", async (_, flags, message) => {
  const { writes } = fakeBunny();

  await expect(init({ name: "site", dir: "dist", ...flags }, false)).rejects.toThrow(message);
  expect(writes).toEqual([]);
});

test("init prints the DNS record for each hostname it adds, with the command that finishes it", async () => {
  fakeBunny();
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  await init({ name: "site", dir: "dist", domain: "www.example.com", alias: "example.com" }, false);

  const output = stripVTControlCharacters(stderr.mock.calls.join(""));
  for (const host of ["www.example.com", "example.com"]) {
    expect(output).toMatch(
      new RegExp(
        `! Add this DNS record, then run \`orbitpush domains add ${host.replaceAll(".", "\\.")}\` to finish:\\s+${host.replaceAll(".", "\\.")} CNAME site\\.b-cdn\\.net`,
      ),
    );
  }
});
