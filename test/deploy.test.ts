import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import type { Config } from "../src/config.ts";
import { deploy } from "../src/deploy.ts";
import { parseRedirects } from "../src/rules.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex").toUpperCase();

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function config(outputDir: string): Config {
  return {
    name: "site",
    outputDir,
    aliases: [],
    region: "DE",
    replicationRegions: ["DE", "NY"],
    geoZones: ["EU"],
    storageZoneId: 1,
    pullZoneId: 2,
  };
}

const kept = parseRedirects("/a /b").rules[0].Description;

function fakeBunny({
  storageZone = { Id: 1, Name: "site", Password: "pw", StorageHostname: "storage.bunnycdn.com" },
  edgeRules = [
    { Guid: "keep", Description: kept, OrderIndex: 0 },
    { Guid: "old", Description: "orbitpush 0000000000 /x /y 301", OrderIndex: 0 },
    { Guid: "mine", Description: "created in dashboard", OrderIndex: 0 },
  ],
  slowAssets = false,
  hostnames = [],
  certificateFails = false,
  storageUnauthorized = 0,
}: {
  storageZone?: Record<string, unknown>;
  edgeRules?: Record<string, unknown>[];
  slowAssets?: boolean;
  hostnames?: { Value: string; HasCertificate: boolean; ForceSSL: boolean }[];
  certificateFails?: boolean;
  storageUnauthorized?: number;
} = {}) {
  let unauthorized = storageUnauthorized;
  const requests: string[] = [];
  const writes: string[] = [];
  const uploads: string[] = [];
  const bodies: Record<string, unknown> = {};
  const edgeRuleWrites: unknown[] = [];

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = input instanceof Request ? input.url : input.toString();
    const method = init.method ?? "GET";
    const json = (value: unknown) => new Response(JSON.stringify(value));

    requests.push(`${method} ${url}`);
    if (method !== "GET") writes.push(`${method} ${url}`);
    if (typeof init.body === "string") bodies[`${method} ${url}`] = JSON.parse(init.body);
    if (url.endsWith("/edgerules/addOrUpdate") && typeof init.body === "string") {
      edgeRuleWrites.push(JSON.parse(init.body));
    }

    if (method === "PUT") {
      const path = url.replace("https://storage.bunnycdn.com/site/", "");
      uploads.push(`start ${path}`);
      await new Promise((resolve) =>
        setTimeout(resolve, slowAssets && !path.endsWith(".html") ? 30 : 0),
      );
      uploads.push(`done ${path}`);
    }

    if (url === "https://api.bunny.net/storagezone/1" && method === "GET") {
      return json(storageZone);
    }

    if (url === "https://api.bunny.net/pullzone/2" && method === "GET") {
      return json({
        Id: 2,
        Name: "site",
        Hostnames: hostnames,
        EdgeRules: edgeRules,
      });
    }

    if (url.startsWith("https://storage.bunnycdn.com/") && unauthorized > 0) {
      unauthorized--;
      return new Response("Unauthorized", { status: 401 });
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

    if (url.startsWith("https://api.bunny.net/pullzone/loadFreeCertificate") && certificateFails) {
      return new Response(JSON.stringify({ Message: "DNS not set up" }), { status: 400 });
    }

    return new Response(null, { status: 201 });
  });

  return { requests, writes, bodies, uploads, edgeRuleWrites };
}

async function settleWithFakeTimers<T>(promise: Promise<T>) {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  while (!settled) {
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(1000);
  }

  return promise;
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

test("deploy keeps the file paths when outputDir starts with ./", async () => {
  const dir = await outputDir();
  const { writes } = fakeBunny();
  const cwd = process.cwd();
  process.chdir(dirname(dir));

  try {
    await deploy("key", config(`./${basename(dir)}`));
  } finally {
    process.chdir(cwd);
  }

  expect(writes).toContain("PUT https://storage.bunnycdn.com/site/index.html");
  expect(writes).not.toContain("DELETE https://storage.bunnycdn.com/site/assets/app.js");
});

test("deploy starts uploading HTML only after every other upload has finished", async () => {
  const dir = await outputDir();
  await writeFile(join(dir, "assets", "app.css"), "new");
  const { uploads } = fakeBunny({ slowAssets: true });

  await deploy("key", config(dir));

  expect(uploads.indexOf("done assets/app.css")).toBeLessThan(uploads.indexOf("start index.html"));
  expect(uploads.indexOf("done assets/app.css")).toBeLessThan(uploads.indexOf("start 404.html"));
});

test("deploy writes a rule listed twice once and deletes a duplicate managed rule", async () => {
  const dir = await outputDir();
  await writeFile(join(dir, "_redirects"), "/a /b\n/c /d\n/c /d");
  const { writes } = fakeBunny({
    edgeRules: [
      { Guid: "keep", Description: kept, OrderIndex: 0 },
      { Guid: "copy", Description: kept, OrderIndex: 0 },
    ],
  });

  await deploy("key", config(dir));

  expect(writes.filter((w) => w.includes("/edgerules/"))).toEqual([
    "POST https://api.bunny.net/pullzone/2/edgerules/addOrUpdate",
    "POST https://api.bunny.net/pullzone/2/edgerules/addOrUpdate",
    "DELETE https://api.bunny.net/pullzone/2/edgerules/copy",
  ]);
});

test("deploy enables exactly the configured delivery regions on the pull zone", async () => {
  const dir = await outputDir();
  const { bodies } = fakeBunny();

  await deploy("key", { ...config(dir), geoZones: ["US", "ASIA"] });

  expect(bodies["POST https://api.bunny.net/pullzone/2"]).toMatchObject({
    EnableGeoZoneEU: false,
    EnableGeoZoneUS: true,
    EnableGeoZoneASIA: true,
    EnableGeoZoneSA: false,
    EnableGeoZoneAF: false,
  });
});

test("deploy serves index.html for unknown paths when _redirects has the SPA rule", async () => {
  const dir = await outputDir();
  await writeFile(join(dir, "_redirects"), "/a /b\n/* /index.html 200");
  const { bodies, writes } = fakeBunny();

  await deploy("key", config(dir));

  expect(writes.filter((w) => w.includes("/edgerules/addOrUpdate"))).toHaveLength(1);
  expect(bodies["POST https://api.bunny.net/storagezone/1"]).toMatchObject({
    Rewrite404To200: true,
    Custom404FilePath: "/index.html",
  });
});

const domainRequests = (requests: string[]) =>
  requests.filter((r) => /addHostname|loadFreeCertificate|setForceSSL/.test(r));

test("deploy adds a new domain, requests its certificate and forces SSL", async () => {
  const dir = await outputDir();
  const { requests, bodies } = fakeBunny({
    hostnames: [{ Value: "site.b-cdn.net", HasCertificate: true, ForceSSL: false }],
  });

  await deploy("key", { ...config(dir), domain: "www.example.com" });

  expect(domainRequests(requests)).toEqual([
    "POST https://api.bunny.net/pullzone/2/addHostname",
    "GET https://api.bunny.net/pullzone/loadFreeCertificate?hostname=www.example.com",
    "POST https://api.bunny.net/pullzone/2/setForceSSL",
  ]);
  expect(bodies["POST https://api.bunny.net/pullzone/2/addHostname"]).toEqual({
    Hostname: "www.example.com",
  });
  expect(bodies["POST https://api.bunny.net/pullzone/2/setForceSSL"]).toEqual({
    Hostname: "www.example.com",
    ForceSSL: true,
  });
});

test("deploy forces SSL on a domain that has a certificate without requesting another", async () => {
  const dir = await outputDir();
  const { requests, bodies } = fakeBunny({
    hostnames: [{ Value: "www.example.com", HasCertificate: true, ForceSSL: false }],
  });

  await deploy("key", { ...config(dir), domain: "www.example.com" });

  expect(domainRequests(requests)).toEqual(["POST https://api.bunny.net/pullzone/2/setForceSSL"]);
  expect(bodies["POST https://api.bunny.net/pullzone/2/setForceSSL"]).toEqual({
    Hostname: "www.example.com",
    ForceSSL: true,
  });
});

test("deploy warns and skips Force SSL when the certificate cannot be obtained", async () => {
  const dir = await outputDir();
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const { requests, writes } = fakeBunny({
    hostnames: [{ Value: "www.example.com", HasCertificate: false, ForceSSL: false }],
    certificateFails: true,
  });

  await deploy("key", { ...config(dir), domain: "www.example.com" });

  expect(domainRequests(requests)).toEqual([
    "GET https://api.bunny.net/pullzone/loadFreeCertificate?hostname=www.example.com",
  ]);
  expect(writes).toContain("POST https://api.bunny.net/pullzone/2/purgeCache");
  expect(stderr.mock.calls.join("")).toContain("www.example.com");
});

test("deploy leaves a domain with certificate and Force SSL alone, matching case-insensitively", async () => {
  const dir = await outputDir();
  const { requests } = fakeBunny({
    hostnames: [{ Value: "www.example.com", HasCertificate: true, ForceSSL: true }],
  });

  await deploy("key", { ...config(dir), domain: "WWW.Example.com" });

  expect(domainRequests(requests)).toEqual([]);
});

test("deploy gives each rule its file position as OrderIndex and rewrites every deployed rule", async () => {
  const dir = await outputDir();
  await writeFile(join(dir, "_redirects"), "/c /d\n/a /b\n/e /f");
  const [c, a, e] = parseRedirects("/c /d\n/a /b\n/e /f").rules;
  const { edgeRuleWrites } = fakeBunny({
    edgeRules: [
      { Guid: "a", Description: a.Description, OrderIndex: 0 },
      { Guid: "e", Description: e.Description, OrderIndex: 2 },
    ],
  });

  await deploy("key", config(dir));

  expect(edgeRuleWrites).toEqual([
    { ...c, OrderIndex: 0 },
    { ...a, Guid: "a", OrderIndex: 1 },
    { ...e, Guid: "e", OrderIndex: 2 },
  ]);
});

test("deploy restores a managed rule edited in the dashboard when the rule files did not change", async () => {
  const dir = await outputDir();
  await writeFile(join(dir, "_redirects"), "/a /b");
  const [a] = parseRedirects("/a /b").rules;
  const { edgeRuleWrites } = fakeBunny({
    edgeRules: [{ Guid: "a", Description: a.Description, OrderIndex: 0 }],
  });

  await deploy("key", config(dir));

  expect(edgeRuleWrites).toEqual([{ ...a, Guid: "a", OrderIndex: 0 }]);
});

test("deploy waits for a new storage zone to accept its password", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const dir = await outputDir();
  const { writes } = fakeBunny({ storageUnauthorized: 2 });

  await settleWithFakeTimers(deploy("key", config(dir)));

  expect(writes).toContain("PUT https://storage.bunnycdn.com/site/index.html");
  expect(writes.at(-1)).toBe("POST https://api.bunny.net/pullzone/2/purgeCache");
});

test("deploy fails without writing when the storage zone keeps rejecting its password", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const dir = await outputDir();
  const { writes } = fakeBunny({ storageUnauthorized: Infinity });

  const error = await settleWithFakeTimers(deploy("key", config(dir)).catch((e: unknown) => e));

  expect(String(error)).toMatch(/HTTP 401/);
  expect(writes).toEqual([]);
});

// bunny.net reads a trigger pattern after "pattern:" as a Lua pattern, whose escape is %
const triggerMatches = (rule: unknown, url: string) =>
  (rule as { Triggers: { PatternMatches: string[] }[] }).Triggers.some((trigger) =>
    trigger.PatternMatches.some((p) =>
      new RegExp(p.replace(/^pattern:/, "").replace(/%(.)/g, "\\$1")).test(url),
    ),
  );

test("deploy keeps the disabled rule while deleting other stale managed rules", async () => {
  const dir = await outputDir();
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const { writes } = fakeBunny({
    edgeRules: [
      { Guid: "off", Description: "orbitpush disabled", OrderIndex: 0 },
      { Guid: "old", Description: "orbitpush 0000000000 /x /y 301", OrderIndex: 1 },
    ],
  });

  await deploy("key", config(dir));

  expect(writes).toContain("DELETE https://api.bunny.net/pullzone/2/edgerules/old");
  expect(writes).not.toContain("DELETE https://api.bunny.net/pullzone/2/edgerules/off");
  expect(writes).toContain("PUT https://storage.bunnycdn.com/site/index.html");
});

test("deploy adds each alias like a domain, lowercased", async () => {
  const dir = await outputDir();
  const { requests, bodies } = fakeBunny({
    hostnames: [{ Value: "www.example.com", HasCertificate: true, ForceSSL: true }],
  });

  await deploy("key", { ...config(dir), domain: "www.example.com", aliases: ["Example.COM"] });

  expect(domainRequests(requests)).toEqual([
    "POST https://api.bunny.net/pullzone/2/addHostname",
    "GET https://api.bunny.net/pullzone/loadFreeCertificate?hostname=example.com",
    "POST https://api.bunny.net/pullzone/2/setForceSSL",
  ]);
  expect(bodies["POST https://api.bunny.net/pullzone/2/addHostname"]).toEqual({
    Hostname: "example.com",
  });
  expect(bodies["POST https://api.bunny.net/pullzone/2/setForceSSL"]).toEqual({
    Hostname: "example.com",
    ForceSSL: true,
  });
});

test("deploy redirects each alias to the main domain and marks the b-cdn.net host noindex, before the file rules", async () => {
  const dir = await outputDir();
  await writeFile(join(dir, "_redirects"), "/a /b");
  const { edgeRuleWrites } = fakeBunny({ edgeRules: [] });

  await deploy("key", {
    ...config(dir),
    domain: "www.example.com",
    aliases: ["example.com", "example.net"],
  });

  const rules = edgeRuleWrites as {
    Description: string;
    ActionType: number;
    ActionParameter1: string;
    ActionParameter2: string;
    OrderIndex: number;
  }[];
  const fileOrder = rules.find((r) => r.Description === kept)?.OrderIndex ?? -Infinity;
  const redirect = (alias: string) =>
    rules.filter(
      (r) =>
        r.ActionType === 1 &&
        r.ActionParameter1 === "https://www.example.com%{Url.Path}" &&
        r.ActionParameter2 === "301" &&
        triggerMatches(r, `https://${alias}/some/page`),
    );
  const noindex = rules.filter(
    (r) =>
      r.ActionType === 5 &&
      r.ActionParameter1 === "X-Robots-Tag" &&
      r.ActionParameter2 === "noindex",
  );

  expect(rules).toHaveLength(4);
  expect(rules.every((r) => r.Description.startsWith("orbitpush "))).toBe(true);
  for (const alias of ["example.com", "example.net"]) {
    expect(redirect(alias)).toHaveLength(1);
    expect(triggerMatches(redirect(alias)[0], "https://www.example.com/some/page")).toBe(false);
    expect(triggerMatches(redirect(alias)[0], "https://shop.example.com/")).toBe(false);
    expect(triggerMatches(redirect(alias)[0], "https://site.b-cdn.net/")).toBe(false);
    expect(redirect(alias)[0].OrderIndex).toBeLessThan(fileOrder);
  }

  expect(noindex).toHaveLength(1);
  expect(triggerMatches(noindex[0], "https://site.b-cdn.net/a")).toBe(true);
  expect(triggerMatches(noindex[0], "http://site.b-cdn.net/")).toBe(true);
  expect(triggerMatches(noindex[0], "https://www.example.com/a")).toBe(false);
  expect(triggerMatches(noindex[0], "https://example.com/a")).toBe(false);
  expect(noindex[0].OrderIndex).toBeLessThan(fileOrder);
});
