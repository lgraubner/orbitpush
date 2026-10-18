import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { deploy } from "../src/deploy.ts";
import { parseRedirects } from "../src/rules.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex").toUpperCase();

test("deploy uploads changed files, deletes stale ones, syncs managed rules and purges", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbitpush-"));
  await mkdir(join(dir, "assets"));
  await writeFile(join(dir, "index.html"), "<h1>new</h1>");
  await writeFile(join(dir, "assets", "app.js"), "same");
  await writeFile(join(dir, "404.html"), "nope");
  await writeFile(join(dir, "_redirects"), "/a /b\n/c /d");

  const kept = parseRedirects("/a /b").rules[0].Description;
  const calls: string[] = [];
  const bodies: Record<string, unknown> = {};
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (typeof init.body === "string") bodies[`${method} ${url}`] = JSON.parse(init.body);
    const json = (value: unknown) => new Response(JSON.stringify(value));
    if (url === "https://api.bunny.net/storagezone/1" && method === "GET")
      return json({ Id: 1, Name: "site", Password: "pw", StorageHostname: "storage.bunnycdn.com" });
    if (url === "https://api.bunny.net/pullzone/2" && method === "GET")
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
    if (url === "https://storage.bunnycdn.com/site/" && method === "GET")
      return json([
        { ObjectName: "assets", IsDirectory: true, Checksum: null },
        { ObjectName: "index.html", IsDirectory: false, Checksum: sha("<h1>old</h1>") },
        { ObjectName: "gone.html", IsDirectory: false, Checksum: "X" },
      ]);
    if (url === "https://storage.bunnycdn.com/site/assets/" && method === "GET")
      return json([{ ObjectName: "app.js", IsDirectory: false, Checksum: sha("same").toLowerCase() }]);
    return new Response(null, { status: 201 });
  }) as typeof fetch;

  await deploy("key", {
    name: "site",
    outputDir: dir,
    spa: false,
    domains: [],
    region: "DE",
    replicationRegions: ["DE", "NY"],
    geoZones: ["EU"],
    storageZoneId: 1,
    pullZoneId: 2,
  });

  const writes = calls.filter((c) => !c.startsWith("GET"));
  assert.deepEqual(writes, [
    "PUT https://storage.bunnycdn.com/site/404.html",
    "PUT https://storage.bunnycdn.com/site/index.html",
    "POST https://api.bunny.net/storagezone/1",
    "POST https://api.bunny.net/pullzone/2",
    "POST https://api.bunny.net/pullzone/2/edgerules/addOrUpdate",
    "DELETE https://api.bunny.net/pullzone/2/edgerules/old",
    "DELETE https://storage.bunnycdn.com/site/gone.html",
    "POST https://api.bunny.net/pullzone/2/purgeCache",
  ]);
  assert.deepEqual(bodies["POST https://api.bunny.net/storagezone/1"], {
    ReplicationRegions: ["NY"],
    Rewrite404To200: false,
    Custom404FilePath: "/404.html",
  });
  assert.match(
    (bodies["POST https://api.bunny.net/pullzone/2/edgerules/addOrUpdate"] as { Description: string }).Description,
    / \/c \/d 301$/,
  );
});
