import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import type { Config } from "../src/config.ts";
import { deploy } from "../src/deploy.ts";
import { domainRules, parseRedirects } from "../src/rules.ts";

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
    trailingSlash: "ignore",
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
  failUpload,
  hang,
}: {
  storageZone?: Record<string, unknown>;
  edgeRules?: Record<string, unknown>[];
  slowAssets?: boolean;
  hostnames?: { Value: string; HasCertificate: boolean; ForceSSL: boolean }[];
  certificateFails?: boolean;
  storageUnauthorized?: number;
  failUpload?: string;
  hang?: string;
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
    if (url === hang) {
      return new Promise((_, reject) =>
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      );
    }

    if (method !== "GET") writes.push(`${method} ${url}`);
    if (typeof init.body === "string") bodies[`${method} ${url}`] = JSON.parse(init.body);
    if (url.endsWith("/edgerules/addOrUpdate") && typeof init.body === "string") {
      edgeRuleWrites.push(JSON.parse(init.body));
    }

    if (method === "PUT") {
      const path = url.replace("https://storage.bunnycdn.com/site/", "");
      uploads.push(`start ${path}`);
      if (path === failUpload) return new Response("boom", { status: 500 });

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

test("deploy caches each hostname separately, so noindex never reaches the domain", async () => {
  const dir = await outputDir();
  const { bodies } = fakeBunny();

  await deploy("key", config(dir));

  expect(bodies["POST https://api.bunny.net/pullzone/2"]).toMatchObject({
    EnableHostnameVary: true,
  });
});

test("deploy makes browsers revalidate every file while bunny.net keeps caching it", async () => {
  const dir = await outputDir();
  const { bodies } = fakeBunny();

  await deploy("key", config(dir));

  expect(bodies["POST https://api.bunny.net/pullzone/2"]).toMatchObject({
    CacheControlPublicMaxAgeOverride: 0,
  });
  expect(bodies["POST https://api.bunny.net/pullzone/2"]).not.toHaveProperty(
    "CacheControlMaxAgeOverride",
  );
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
  (rule as { Triggers: { Type: number; PatternMatches: string[] }[] }).Triggers.some(
    (trigger) =>
      trigger.Type === 0 &&
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

type Rule = {
  Description: string;
  ActionType: number;
  ActionParameter1: string;
  ActionParameter2: string;
  OrderIndex: number;
  TriggerMatchingType: number;
  Triggers: { Type: number; PatternMatchingType: number; PatternMatches: string[] }[];
};

async function slashRules(trailingSlash?: Config["trailingSlash"], redirects = "/a /b") {
  const dir = await outputDir();
  await writeFile(join(dir, "_redirects"), redirects);
  const { edgeRuleWrites } = fakeBunny({ edgeRules: [] });

  await deploy("key", { ...config(dir), trailingSlash });

  const rules = edgeRuleWrites as Rule[];
  const slash = rules.filter((r) => r.ActionType === 1 && r.Description.includes("trailing slash"));
  return { rules, slash };
}

test("deploy redirects extensionless paths to their trailing slash by default, after the file rules", async () => {
  const { rules, slash } = await slashRules();

  expect(slash).toHaveLength(1);
  const [rule] = slash;
  expect(rule.ActionParameter1).toBe("https://%{Url.Hostname}%{Url.Directory}%{Url.FileName}/");
  expect(rule.ActionParameter2).toBe("301");
  for (const url of [
    "https://site.b-cdn.net/guides",
    "https://www.example.com/a/b",
    "https://x.y/v1.2/docs",
  ]) {
    expect(triggerMatches(rule, url), url).toBe(true);
  }
  for (const url of [
    "https://site.b-cdn.net/",
    "https://site.b-cdn.net/guides/",
    "https://site.b-cdn.net/a/app.js",
    "https://site.b-cdn.net/a.html",
  ]) {
    expect(triggerMatches(rule, url), url).toBe(false);
  }
  expect(rule.OrderIndex).toBeGreaterThan(
    rules.find((r) => r.Description === kept)?.OrderIndex ?? Infinity,
  );
});

test("deploy adds no trailing slash rule in SPA mode unless one is configured", async () => {
  const spa = "/a /b\n/* /index.html 200";

  expect((await slashRules(undefined, spa)).slash).toHaveLength(0);
  expect((await slashRules("always", spa)).slash).toHaveLength(1);
});

test("deploy adds no trailing slash rule with trailingSlash ignore", async () => {
  expect((await slashRules("ignore")).slash).toHaveLength(0);
});

test("deploy strips the trailing slash with trailingSlash never, except with a query string", async () => {
  const { slash } = await slashRules("never");

  expect(slash).toHaveLength(1);
  const [rule] = slash;
  expect(rule.ActionParameter1).toBe("https://%{Url.Hostname}/%{Path.0-}");
  expect(rule.ActionParameter2).toBe("301");
  expect(triggerMatches(rule, "https://site.b-cdn.net/guides/")).toBe(true);
  expect(triggerMatches(rule, "https://site.b-cdn.net/a/b/")).toBe(true);
  expect(triggerMatches(rule, "https://site.b-cdn.net/")).toBe(false);
  expect(triggerMatches(rule, "https://site.b-cdn.net/guides")).toBe(false);
  expect(rule.TriggerMatchingType).toBe(1);
  expect(rule.Triggers).toContainEqual({ Type: 6, PatternMatchingType: 2, PatternMatches: ["*"] });
});

const redirectLines = (count: number, prefix = "r") =>
  Array.from({ length: count }, (_, i) => `/${prefix}${i} /b`).join("\n");

test("deploy fails before any write when the rules need a full zone, which bunny.net no longer writes to", async () => {
  const dir = await outputDir();
  await writeFile(join(dir, "_redirects"), redirectLines(49));
  const { writes } = fakeBunny({
    edgeRules: [{ Guid: "mine", Description: "created in dashboard", OrderIndex: 0 }],
  });

  await expect(deploy("key", config(dir))).rejects.toThrow(/50 edge rules/);
  expect(writes).toEqual([]);
});

test("deploy accepts 49 edge rules, counting the ones from the dashboard", async () => {
  const dir = await outputDir();
  await writeFile(join(dir, "_redirects"), redirectLines(48));
  const { edgeRuleWrites } = fakeBunny({
    edgeRules: [{ Guid: "mine", Description: "created in dashboard", OrderIndex: 0 }],
  });

  await deploy("key", config(dir));

  expect(edgeRuleWrites).toHaveLength(48);
});

test("deploy deletes removed rules first when adding first would fill the zone", async () => {
  const dir = await outputDir();
  await writeFile(join(dir, "_redirects"), `${redirectLines(48)}\n/new /b`);
  const old = parseRedirects(`${redirectLines(48)}\n/gone /b`).rules;
  const { writes } = fakeBunny({
    edgeRules: old.map((r, i) => ({ Guid: `g${i}`, Description: r.Description, OrderIndex: i })),
  });

  await deploy("key", config(dir));

  const ruleWrites = writes.filter((w) => w.includes("/edgerules/"));
  expect(ruleWrites[0]).toBe("DELETE https://api.bunny.net/pullzone/2/edgerules/g48");
  expect(ruleWrites).toHaveLength(50);
});

test("deploy frees a zone left full by an earlier version once a line is removed", async () => {
  const dir = await outputDir();
  await writeFile(join(dir, "_redirects"), redirectLines(49));
  const old = parseRedirects(redirectLines(50)).rules;
  const { writes } = fakeBunny({
    edgeRules: old.map((r, i) => ({ Guid: `g${i}`, Description: r.Description, OrderIndex: i })),
  });

  await deploy("key", config(dir));

  const ruleWrites = writes.filter((w) => w.includes("/edgerules/"));
  expect(ruleWrites[0]).toBe("DELETE https://api.bunny.net/pullzone/2/edgerules/g49");
});

test("deploy adds new rules before deleting old ones while the zone has room", async () => {
  const dir = await outputDir();
  await writeFile(join(dir, "_redirects"), "/a /b\n/new /b");
  const { writes } = fakeBunny();

  await deploy("key", config(dir));

  const ruleWrites = writes.filter((w) => w.includes("/edgerules/"));
  expect(ruleWrites.at(-1)).toMatch(/^DELETE /);
  expect(ruleWrites[0]).toMatch(/^POST /);
});

test("deploy turns the 404 page off when the output directory has no 404.html", async () => {
  const dir = await outputDir();
  await rm(join(dir, "404.html"));
  const { bodies } = fakeBunny();

  await deploy("key", config(dir));

  expect(bodies["POST https://api.bunny.net/storagezone/1"]).toMatchObject({
    Rewrite404To200: false,
    Custom404FilePath: "",
  });
});

test("deploy counts the disabled rule toward the edge rule limit", async () => {
  const dir = await outputDir();
  await writeFile(join(dir, "_redirects"), redirectLines(49));
  const { writes } = fakeBunny({
    edgeRules: [{ Guid: "off", Description: "orbitpush disabled", OrderIndex: 0 }],
  });

  await expect(deploy("key", config(dir))).rejects.toThrow(/50 edge rules/);
  expect(writes).toEqual([]);
});

test("deploy uploads a symlinked file with the content it points to", async () => {
  const dir = await outputDir();
  const outside = await mkdtemp(join(tmpdir(), "orbitpush-outside-"));
  await writeFile(join(outside, "shared.css"), "shared");
  await symlink(join(outside, "shared.css"), join(dir, "assets", "shared.css"));
  const { bodies, writes } = fakeBunny();
  const put = "PUT https://storage.bunnycdn.com/site/assets/shared.css";

  await deploy("key", config(dir));

  expect(writes).toContain(put);
  expect(bodies).not.toHaveProperty(put);
});

test("deploy warns about a symlinked directory instead of skipping it silently", async () => {
  const dir = await outputDir();
  const outside = await mkdtemp(join(tmpdir(), "orbitpush-outside-"));
  await writeFile(join(outside, "page.html"), "page");
  await symlink(outside, join(dir, "linked"));
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  fakeBunny();

  await deploy("key", config(dir));

  expect(stderr.mock.calls.join("")).toMatch(/linked/);
});

test("deploy warns about a hostname on the pull zone that orbitpush.json no longer lists", async () => {
  const dir = await outputDir();
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  fakeBunny({
    hostnames: [
      { Value: "site.b-cdn.net", HasCertificate: true, ForceSSL: false },
      { Value: "www.example.com", HasCertificate: true, ForceSSL: true },
      { Value: "Example.com", HasCertificate: true, ForceSSL: true },
      { Value: "old.example.com", HasCertificate: true, ForceSSL: true },
    ],
  });

  await deploy("key", { ...config(dir), domain: "www.example.com", aliases: ["example.com"] });

  const warnings = stderr.mock.calls.map(String).filter((line) => line.includes("!"));
  expect(warnings.filter((line) => line.includes("old.example.com"))).toHaveLength(1);
  expect(warnings.filter((line) => /b-cdn\.net|www\.example\.com|Example\.com/.test(line))).toEqual(
    [],
  );
});

test("deploy starts no further upload once one has failed", async () => {
  const dir = await outputDir();
  for (let i = 0; i < 20; i++) await writeFile(join(dir, "assets", `f${i}.js`), String(i));
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const { uploads } = fakeBunny({ slowAssets: true, failUpload: "assets/f0.js" });

  await expect(deploy("key", config(dir))).rejects.toThrow(/PUT \/assets\/f0\.js failed/);
  await new Promise((resolve) => setTimeout(resolve, 100));

  expect(uploads.filter((u) => u.startsWith("start "))).toHaveLength(8);
});

test.each([
  ["a bunny.net API request", "https://api.bunny.net/storagezone/1", /GET \/storagezone\/1 failed/],
  ["a storage zone listing", "https://storage.bunnycdn.com/site/", /GET \/ failed/],
  ["a stale file deletion", "https://storage.bunnycdn.com/site/gone.html", /DELETE \/gone\.html/],
])("deploy fails instead of hanging when %s never answers", async (_, url, message) => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(10));
  const dir = await outputDir();
  fakeBunny({ hang: url });

  await expect(deploy("key", config(dir))).rejects.toThrow(message);
});

test("deploy deletes the old alias redirect before writing the swapped one, so the two never loop", async () => {
  const dir = await outputDir();
  const before = domainRules({ name: "site", domain: "www.example.com", aliases: ["example.com"] });
  const { writes } = fakeBunny({
    hostnames: [
      { Value: "www.example.com", HasCertificate: true, ForceSSL: true },
      { Value: "example.com", HasCertificate: true, ForceSSL: true },
    ],
    edgeRules: before.map((r, i) => ({ Guid: `g${i}`, Description: r.Description, OrderIndex: i })),
  });

  await deploy("key", { ...config(dir), domain: "example.com", aliases: ["www.example.com"] });

  const ruleWrites = writes.filter((w) => w.includes("/edgerules/"));
  expect(ruleWrites[0]).toBe("DELETE https://api.bunny.net/pullzone/2/edgerules/g0");
  expect(ruleWrites.slice(1)).toEqual([
    "POST https://api.bunny.net/pullzone/2/edgerules/addOrUpdate",
    "POST https://api.bunny.net/pullzone/2/edgerules/addOrUpdate",
  ]);
});
