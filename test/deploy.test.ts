import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import type { Config } from "../src/config.ts";
import { deploy } from "../src/deploy.ts";
import { parseRedirects } from "../src/rules.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex").toUpperCase();

afterEach(() => {
  vi.restoreAllMocks();
});

function config(outputDir: string): Config {
  return {
    name: "site",
    outputDir,
    spa: false,
    domains: [],
    region: "DE",
    replicationRegions: ["DE", "NY"],
    geoZones: ["EU"],
    storageZoneId: 1,
    pullZoneId: 2,
  };
}

function fakeBunny({
  storageZone = { Id: 1, Name: "site", Password: "pw", StorageHostname: "storage.bunnycdn.com" },
}: { storageZone?: Record<string, unknown> } = {}) {
  const kept = parseRedirects("/a /b").rules[0].Description;
  const writes: string[] = [];
  const bodies: Record<string, unknown> = {};

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = input instanceof Request ? input.url : input.toString();
    const method = init.method ?? "GET";
    const json = (value: unknown) => new Response(JSON.stringify(value));

    if (method !== "GET") writes.push(`${method} ${url}`);
    if (typeof init.body === "string") bodies[`${method} ${url}`] = JSON.parse(init.body);

    if (url === "https://api.bunny.net/storagezone/1" && method === "GET") {
      return json(storageZone);
    }

    if (url === "https://api.bunny.net/pullzone/2" && method === "GET") {
      return json({
        Id: 2,
        Name: "site",
        Hostnames: [],
        EdgeRules: [
          { Guid: "keep", Description: kept },
          { Guid: "old", Description: "orbitpush 0000000000 /x /y 301" },
          { Guid: "mine", Description: "created in dashboard" },
        ],
      });
    }

    if (url === "https://storage.bunnycdn.com/site/" && method === "GET") {
      return json([
        { ObjectName: "assets", IsDirectory: true, Checksum: null },
        { ObjectName: "index.html", IsDirectory: false, Checksum: sha("<h1>old</h1>") },
        { ObjectName: "gone.html", IsDirectory: false, Checksum: "X" },
      ]);
    }

    if (url === "https://storage.bunnycdn.com/site/assets/" && method === "GET") {
      return json([
        { ObjectName: "app.js", IsDirectory: false, Checksum: sha("same").toLowerCase() },
      ]);
    }

    return new Response(null, { status: 201 });
  });

  return { writes, bodies };
}

async function outputDir() {
  const dir = await mkdtemp(join(tmpdir(), "orbitpush-"));
  await mkdir(join(dir, "assets"));
  await writeFile(join(dir, "index.html"), "<h1>new</h1>");
  await writeFile(join(dir, "assets", "app.js"), "same");
  await writeFile(join(dir, "404.html"), "nope");

  return dir;
}

test("deploy uploads changed files, deletes stale ones, syncs managed rules and purges", async () => {
  const dir = await outputDir();
  await writeFile(join(dir, "_redirects"), "/a /b\n/c /d");
  const { writes, bodies } = fakeBunny();

  await deploy("key", config(dir));

  expect(writes).toEqual([
    "PUT https://storage.bunnycdn.com/site/404.html",
    "PUT https://storage.bunnycdn.com/site/index.html",
    "POST https://api.bunny.net/storagezone/1",
    "POST https://api.bunny.net/pullzone/2",
    "POST https://api.bunny.net/pullzone/2/edgerules/addOrUpdate",
    "DELETE https://api.bunny.net/pullzone/2/edgerules/old",
    "DELETE https://storage.bunnycdn.com/site/gone.html",
    "POST https://api.bunny.net/pullzone/2/purgeCache",
  ]);
  expect(bodies["POST https://api.bunny.net/storagezone/1"]).toEqual({
    ReplicationRegions: ["NY"],
    Rewrite404To200: false,
    Custom404FilePath: "/404.html",
  });
  expect(bodies["POST https://api.bunny.net/pullzone/2/edgerules/addOrUpdate"]).toMatchObject({
    Description: expect.stringMatching(/ \/c \/d 301$/),
  });
});

test("deploy fails before any write when a rule file exists but cannot be read", async () => {
  const dir = await outputDir();
  // A directory named _redirects makes readFile fail with EISDIR instead of ENOENT
  await mkdir(join(dir, "_redirects"));
  const { writes } = fakeBunny();

  await expect(deploy("key", config(dir))).rejects.toMatchObject({ code: "EISDIR" });
  expect(writes).toEqual([]);
});

test("deploy fails before any write when bunny.net returns an unexpected storage zone", async () => {
  const dir = await outputDir();
  const { writes } = fakeBunny({ storageZone: { Id: 1, Name: "site" } });

  await expect(deploy("key", config(dir))).rejects.toThrow(/bunny\.net returned an unexpected/);
  expect(writes).toEqual([]);
});

test("deploy reports an output directory that is not a directory as such, not as missing", async () => {
  const dir = await outputDir();
  const file = join(dir, "index.html");
  const { writes } = fakeBunny();

  await expect(deploy("key", config(file))).rejects.toMatchObject({ code: "ENOTDIR" });
  expect(writes).toEqual([]);
});

test("deploy tells the user to build when the output directory is missing", async () => {
  const dir = await outputDir();
  const { writes } = fakeBunny();

  await expect(deploy("key", config(join(dir, "missing")))).rejects.toThrow(
    /Output directory ".*missing" not found\. Did you run the build\?/,
  );
  expect(writes).toEqual([]);
});
