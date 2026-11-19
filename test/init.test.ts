import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { ApiError } from "../src/bunny.ts";
import { init } from "../src/commands/init.ts";
import { z } from "../src/zod.ts";

type Prompt = {
  message: string;
  default?: unknown;
  choices?: (string | { value: unknown; checked?: boolean })[];
};

const asked: string[] = [];
const prompts: Prompt[] = [];
const replies: { message: RegExp; answer: unknown }[] = [];
const value = (choice: string | { value: unknown }) =>
  typeof choice === "string" ? choice : choice.value;

// Answers every prompt with its default, so an interactive init runs without a terminal
vi.mock("@inquirer/prompts", () => {
  const answer = (fallback: (p: Prompt) => unknown) => async (p: Prompt) => {
    asked.push(p.message);
    prompts.push(p);
    const reply = replies.findIndex((r) => r.message.test(p.message));
    if (reply !== -1) return replies.splice(reply, 1)[0]?.answer;

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
  prompts.length = 0;
  replies.length = 0;
  vi.stubEnv("BUNNY_API_KEY", "key");
});

afterEach(async () => {
  process.chdir(cwd);
  await chmod(dir, 0o755);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type ZoneKind = "storagezone" | "pullzone";

function fakeBunny({
  pullZoneTaken = false,
  failDelete,
  taken = {},
  failCheck = false,
}: {
  pullZoneTaken?: boolean;
  failDelete?: string;
  taken?: Partial<Record<ZoneKind, string[]>>;
  failCheck?: boolean;
} = {}) {
  const writes: string[] = [];
  const checks: { request: string; body: unknown }[] = [];
  const bodies: Record<string, unknown> = {};

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = input instanceof Request ? input.url : input.toString();
    const method = init.method ?? "GET";
    const json = (value: unknown) => new Response(JSON.stringify(value));
    const check = /^https:\/\/api\.bunny\.net\/(storagezone|pullzone)\/checkavailability$/.exec(
      url,
    );

    if (check && method === "POST") {
      const body: unknown = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
      checks.push({ request: `${method} ${url}`, body });
      if (failCheck) {
        return new Response(JSON.stringify({ Message: "Authorization has been denied" }), {
          status: 401,
        });
      }

      const kind: ZoneKind = check[1] === "pullzone" ? "pullzone" : "storagezone";
      const { Name } = z.object({ Name: z.string() }).parse(body);
      return json({ Available: !(taken[kind] ?? []).includes(Name) });
    }

    if (method !== "GET") writes.push(`${method} ${url}`);
    if (typeof init.body === "string") bodies[`${method} ${url}`] = JSON.parse(init.body);
    if (method === "DELETE" && url === failDelete) {
      return new Response(JSON.stringify({ Message: "Zone is locked" }), { status: 500 });
    }
    if (url === "https://api.bunny.net/storagezone" && method === "POST") return json({ Id: 1 });
    if (url === "https://api.bunny.net/pullzone" && method === "POST") {
      return pullZoneTaken
        ? new Response(JSON.stringify({ Message: "name taken" }), { status: 400 })
        : json({ Id: 2 });
    }

    if (url === "https://api.bunny.net/pullzone/2") {
      return json({
        Id: 2,
        Name: "site",
        OriginType: 2,
        StorageZoneId: 1,
        Hostnames: [],
        EdgeRules: [],
      });
    }

    return new Response(null, { status: 204 });
  });

  return { writes, checks, bodies };
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
    pullZoneId: 2,
  });
  expect(written).not.toHaveProperty("storageZoneId");
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

test("init writes no domain key without a custom domain", async () => {
  fakeBunny();

  await init({ name: "site", yes: true }, false);

  const written = JSON.parse(await readFile("orbitpush.json", "utf8")) as Record<string, unknown>;
  expect(written).not.toHaveProperty("domain");
  expect(written).toMatchObject({ aliases: [] });
});

test.each([
  ["with a space", "my site"],
  ["with a dot", "my.site"],
  ["that is empty", ""],
])("init rejects a name %s before sending anything to bunny.net", async (_, name) => {
  const { writes } = fakeBunny();

  await expect(init({ name, yes: true }, false)).rejects.toThrow(/name/i);
  expect(writes).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
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
  ["an unknown main region", { region: "MARS" }, /region/i],
])("init rejects %s before sending anything to bunny.net", async (_, flags, message) => {
  const { writes } = fakeBunny();

  await expect(init({ name: "site", yes: true, ...flags }, false)).rejects.toThrow(message);
  expect(writes).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
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

test("init prints the next steps", async () => {
  const second = "2. Use your own domain: `npx orbitpush domains add www.example.com`";
  fakeBunny();
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  await init({ name: "site", dir: "dist" }, false);

  const output = stripVTControlCharacters(stderr.mock.calls.join(""));
  const next = output.indexOf("Next:");
  const first = output.indexOf("1. Build your site, then run `npx orbitpush deploy`");
  expect(next).toBeGreaterThan(-1);
  expect(first).toBeGreaterThan(next);
  expect(output.indexOf(second)).toBeGreaterThan(first);
});

test("init tells the user to delete a zone in the dashboard when its cleanup fails", async () => {
  const { writes } = fakeBunny({ failDelete: "https://api.bunny.net/pullzone/2" });
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  await chmod(dir, 0o555);

  await expect(init({ name: "site", yes: true }, false)).rejects.toMatchObject({ code: "EACCES" });
  const output = stripVTControlCharacters(stderr.mock.calls.join(""));

  expect(writes).toContain("DELETE https://api.bunny.net/pullzone/2");
  expect(output).toContain(
    'Could not delete the pull zone site (2): bunny.net says "Zone is locked"',
  );
  expect(output).toMatch(/^\W*Delete the pull zone site \(2\) in the bunny\.net dashboard\.$/m);
});

const storageCheck = "POST https://api.bunny.net/storagezone/checkavailability";
const pullCheck = "POST https://api.bunny.net/pullzone/checkavailability";
const created = ["POST https://api.bunny.net/storagezone", "POST https://api.bunny.net/pullzone"];
const takenMessage = (name: string) =>
  `The name "${name}" is already taken on bunny.net. Choose another with --name.`;

test("init checks the name with both zone kinds before it creates them", async () => {
  const { writes, checks } = fakeBunny();

  await init({ name: "site", yes: true }, false);

  expect(checks).toHaveLength(2);
  expect(checks).toEqual(
    expect.arrayContaining([
      { request: storageCheck, body: { Name: "site" } },
      { request: pullCheck, body: { Name: "site" } },
    ]),
  );
  expect(writes).toEqual(created);
});

test.each([
  ["a storage zone", { storagezone: ["site"] }],
  ["a pull zone", { pullzone: ["site"] }],
  ["both zone kinds", { storagezone: ["site"], pullzone: ["site"] }],
])("init stops before any write when the name is taken by %s", async (_, taken) => {
  const { writes } = fakeBunny({ taken });

  await expect(init({ name: "site", yes: true }, false)).rejects.toThrow(takenMessage("site"));
  expect(writes).toEqual([]);
});

test.each([
  ["--name and --dir without a terminal", { name: "site", dir: "dist" }, false],
  ["--name in a terminal", { name: "site" }, true],
])("init with %s fails on a taken name without asking for another", async (_, flags, terminal) => {
  const { writes, checks } = fakeBunny({ taken: { pullzone: ["site"] } });
  vi.spyOn(process.stderr, "write").mockReturnValue(true);

  await expect(init(flags, terminal)).rejects.toThrow(takenMessage("site"));
  expect(checks.length).toBeGreaterThan(0);
  expect(asked).toEqual([]);
  expect(writes).toEqual([]);
});

test("init --yes fails on a taken default name instead of picking another", async () => {
  const name = basename(dir).toLowerCase();
  const { writes, checks } = fakeBunny({ taken: { storagezone: [name] } });

  await expect(init({ yes: true }, false)).rejects.toThrow(takenMessage(name));
  expect(checks.length).toBeGreaterThan(0);
  expect(checks.map((c) => c.body)).toEqual(checks.map(() => ({ Name: name })));
  expect(writes).toEqual([]);
});

test("init stops before any write when bunny.net cannot answer the name check", async () => {
  const { writes, checks } = fakeBunny({ failCheck: true });

  const error = await init({ name: "site", yes: true }, false).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status: 401 });
  expect(checks.length).toBeGreaterThan(0);
  expect(writes).toEqual([]);
});

test("init in a terminal asks for another name while the name is taken", async () => {
  const name = basename(dir).toLowerCase();
  const { writes, checks, bodies } = fakeBunny({ taken: { pullzone: [name] } });
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  replies.push({ message: /name/i, answer: name }, { message: /name/i, answer: "fresh" });

  await init({}, true);

  const namePrompts = prompts.filter((p) => /name/i.test(p.message));
  expect(namePrompts).toHaveLength(2);
  expect(namePrompts[0]?.default).toBe(name);
  expect(namePrompts[1]?.default).toBeUndefined();
  expect(stripVTControlCharacters(stderr.mock.calls.join(""))).toContain(
    `"${name}" is already taken on bunny.net`,
  );
  expect(checks.map((c) => c.body)).toEqual(expect.arrayContaining([{ Name: "fresh" }]));
  expect(writes).toEqual(created);
  expect(bodies["POST https://api.bunny.net/storagezone"]).toMatchObject({ Name: "fresh" });
  expect(bodies["POST https://api.bunny.net/pullzone"]).toMatchObject({ Name: "fresh" });
});
