import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { afterEach, expect, test, vi } from "vitest";

import type { Config, Redirect } from "../src/config.ts";
import { deploy } from "../src/commands/deploy.ts";
import { domainRules, isAliasRule, redirectRules, trailingSlashRule } from "../src/rules.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex").toUpperCase();

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const redirects = (lines = ""): Redirect[] =>
  lines
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [from, to, status = "301"] = line.split(" ");
      return { from, to, status: Number(status) };
    });

function config(outputDir: string, redirectLines?: string): Config {
  return {
    name: "site",
    outputDir,
    aliases: [],
    region: "DE",
    replicationRegions: ["DE", "NY"],
    geoZones: ["EU"],
    trailingSlash: "ignore",
    redirects: redirects(redirectLines),
    headers: [],
    storageZoneId: 1,
    pullZoneId: 2,
  };
}

const kept = redirectRules(redirects("/a /b")).rules[0].Description;

const RECORD_URL = "https://storage.bunnycdn.com/site/.orbitpush/stale.json";
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-15T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const LONG_AGO = "2020-01-01T00:00:00.000Z";

function freezeTime() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
}

const object = (ObjectName: string, Checksum = "X") => ({
  ObjectName,
  IsDirectory: false,
  Checksum,
});
const folder = (ObjectName: string) => ({
  ObjectName,
  IsDirectory: true,
  Checksum: null,
});

const defaultListing: Record<string, ReturnType<typeof object | typeof folder>[]> = {
  "": [folder("assets"), object("index.html", sha("<h1>old</h1>")), object("gone.html")],
  "assets/": [object("app.js", sha("same").toLowerCase())],
};

async function decode(body: unknown) {
  if (typeof body === "string") return body;
  if (body instanceof Blob) return body.text();
  if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
  throw new Error(`unexpected stale record body: ${String(body)}`);
}

function fakeBunny({
  storageZone = {
    Id: 1,
    Name: "site",
    Password: "pw",
    StorageHostname: "storage.bunnycdn.com",
  },
  edgeRules = [
    { Guid: "keep", Description: kept, OrderIndex: 0 },
    {
      Guid: "old",
      Description: "orbitpush 0000000000 /x /y 301",
      OrderIndex: 0,
    },
    { Guid: "mine", Description: "created in dashboard", OrderIndex: 0 },
  ],
  slowAssets = false,
  hostnames = [],
  certificateFails = false,
  storageUnauthorized = 0,
  failUpload,
  hang,
  pullZoneName = "site",
  listing = defaultListing,
  staleRecord,
}: {
  storageZone?: Record<string, unknown>;
  edgeRules?: Record<string, unknown>[];
  slowAssets?: boolean;
  hostnames?: { Value: string; HasCertificate: boolean; ForceSSL: boolean }[];
  certificateFails?: boolean | string;
  storageUnauthorized?: number;
  failUpload?: string;
  hang?: string;
  pullZoneName?: string;
  listing?: typeof defaultListing;
  staleRecord?: { version: unknown; stale: Record<string, unknown> } | string;
} = {}) {
  let unauthorized = storageUnauthorized;
  const requests: string[] = [];
  const writes: string[] = [];
  const uploads: string[] = [];
  const bodies: Record<string, unknown> = {};
  const edgeRuleWrites: unknown[] = [];
  const hostnameRemovals: unknown[] = [];
  const records: unknown[] = [];

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
    if (url === RECORD_URL && method === "PUT") records.push(JSON.parse(await decode(init.body)));
    else if (typeof init.body === "string") bodies[`${method} ${url}`] = JSON.parse(init.body);
    if (url.endsWith("/edgerules/addOrUpdate") && typeof init.body === "string") {
      edgeRuleWrites.push(JSON.parse(init.body));
    }
    if (url.endsWith("/removeHostname") && typeof init.body === "string") {
      hostnameRemovals.push(JSON.parse(init.body));
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
        Name: pullZoneName,
        Hostnames: hostnames,
        EdgeRules: edgeRules,
      });
    }

    if (url.startsWith("https://storage.bunnycdn.com/") && unauthorized > 0) {
      unauthorized--;
      return new Response("Unauthorized", { status: 401 });
    }

    if (url === RECORD_URL && method === "GET") {
      if (staleRecord === undefined) return new Response("Not Found", { status: 404 });
      return new Response(
        typeof staleRecord === "string" ? staleRecord : JSON.stringify(staleRecord),
      );
    }

    const folderPath = url.replace("https://storage.bunnycdn.com/site/", "");
    if (
      url.startsWith("https://storage.bunnycdn.com/site/") &&
      method === "GET" &&
      listing[folderPath]
    ) {
      return json(listing[folderPath]);
    }

    if (url.startsWith("https://api.bunny.net/pullzone/loadFreeCertificate") && certificateFails) {
      return new Response(
        JSON.stringify({
          Message:
            typeof certificateFails === "string"
              ? certificateFails
              : "The domain www.example.com is not pointing to our servers.",
        }),
        { status: 400 },
      );
    }

    return new Response(null, { status: 201 });
  });

  return {
    requests,
    writes,
    bodies,
    uploads,
    edgeRuleWrites,
    hostnameRemovals,
    records,
  };
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

test("deploy uploads changed files, deletes expired stale ones, syncs managed rules, rewrites the stale record and purges", async () => {
  const dir = await outputDir();
  const { writes, bodies, records } = fakeBunny({
    staleRecord: { version: 1, stale: { "gone.html": LONG_AGO } },
  });

  await deploy("key", config(dir, "/a /b\n/c /d"));

  expect(writes).toEqual([
    "PUT https://storage.bunnycdn.com/site/404.html",
    "PUT https://storage.bunnycdn.com/site/index.html",
    "POST https://api.bunny.net/storagezone/1",
    "POST https://api.bunny.net/pullzone/2",
    "POST https://api.bunny.net/pullzone/2/edgerules/addOrUpdate",
    "POST https://api.bunny.net/pullzone/2/edgerules/addOrUpdate",
    "DELETE https://api.bunny.net/pullzone/2/edgerules/old",
    "DELETE https://storage.bunnycdn.com/site/gone.html",
    `PUT ${RECORD_URL}`,
    "POST https://api.bunny.net/pullzone/2/purgeCache",
  ]);
  expect(records).toEqual([{ version: 1, stale: {} }]);
  expect(bodies["POST https://api.bunny.net/storagezone/1"]).toEqual({
    ReplicationRegions: ["NY"],
    Rewrite404To200: false,
    Custom404FilePath: "/404.html",
  });
  expect(bodies["POST https://api.bunny.net/pullzone/2/edgerules/addOrUpdate"]).toMatchObject({
    Description: expect.stringMatching(/ \/c \/d 301$/),
  });
});

test("deploy says where it deploys before the summary: domain, zones from bunny.net, replicas and aliases", async () => {
  const dir = await outputDir();
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  fakeBunny({
    pullZoneName: "site-cdn",
    hostnames: [{ Value: "www.example.com", HasCertificate: true, ForceSSL: true }],
  });

  await deploy("key", {
    ...config(dir),
    name: "project",
    domain: "www.example.com",
    aliases: ["example.com", "old.example.com"],
    region: "UK",
    replicationRegions: ["UK", "DE", "NY"],
  });

  const output = stripVTControlCharacters(stderr.mock.calls.join(""));
  const header = output.indexOf(`Deploying ${dir} to https://www.example.com`);
  expect(header).toBeGreaterThanOrEqual(0);
  expect(output).toContain("Storage zone  site (UK, replicated to DE, NY)");
  expect(output).toContain("Pull zone     site-cdn");
  expect(output).toContain("Aliases       example.com, old.example.com");
  expect(output.indexOf("› Files:")).toBeGreaterThan(header);
});

test("deploy names the b-cdn.net URL until the domain has a certificate", async () => {
  const dir = await outputDir();
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  fakeBunny({
    pullZoneName: "site-cdn",
    hostnames: [{ Value: "www.example.com", HasCertificate: false, ForceSSL: false }],
    certificateFails: true,
  });

  const url = await deploy("key", {
    ...config(dir),
    domain: "www.example.com",
  });

  const output = stripVTControlCharacters(stderr.mock.calls.join(""));
  expect(output).toContain(`Deploying ${dir} to https://site-cdn.b-cdn.net`);
  expect(url).toBe("https://site-cdn.b-cdn.net");
});

test("deploy returns the domain URL once it gets the domain a certificate", async () => {
  const dir = await outputDir();
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  fakeBunny({
    pullZoneName: "site-cdn",
    hostnames: [{ Value: "www.example.com", HasCertificate: false, ForceSSL: false }],
  });

  const url = await deploy("key", {
    ...config(dir),
    domain: "www.example.com",
  });

  expect(url).toBe("https://www.example.com");
});

test("deploy names the b-cdn.net URL and lists no replicas or aliases when there are none", async () => {
  const dir = await outputDir();
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  fakeBunny({ pullZoneName: "site-cdn" });

  await deploy("key", {
    ...config(dir),
    name: "project",
    replicationRegions: ["DE"],
  });

  const output = stripVTControlCharacters(stderr.mock.calls.join(""));
  const header = output.indexOf(`Deploying ${dir} to https://site-cdn.b-cdn.net`);
  expect(header).toBeGreaterThanOrEqual(0);
  expect(output).toContain("Storage zone  site (DE)\n");
  expect(output).toContain("Pull zone     site-cdn");
  expect(output).not.toContain("Aliases");
  expect(output.indexOf("› Files:")).toBeGreaterThan(header);
});

test("deploy shows one project line instead of the zones when both zones carry the project name", async () => {
  const dir = await outputDir();
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  fakeBunny();

  await deploy("key", { ...config(dir), replicationRegions: ["DE"] });

  const output = stripVTControlCharacters(stderr.mock.calls.join(""));
  const header = output.indexOf(`Deploying ${dir} to https://site.b-cdn.net`);
  expect(header).toBeGreaterThanOrEqual(0);
  expect(output).toContain("Project    site (DE)\n");
  expect(output).toContain("bunny.net  https://dash.bunny.net/cdn/2\n");
  expect(output).not.toContain("Storage zone");
  expect(output).not.toContain("Pull zone");
  expect(output).not.toContain("Aliases");
  expect(output.indexOf("› Files:")).toBeGreaterThan(header);
});

test("deploy pads the aliases to the project label when both zones carry the project name", async () => {
  const dir = await outputDir();
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  fakeBunny();

  await deploy("key", {
    ...config(dir),
    aliases: ["example.com", "old.example.com"],
    region: "UK",
    replicationRegions: ["UK", "DE", "NY"],
  });

  const output = stripVTControlCharacters(stderr.mock.calls.join(""));
  expect(output).toContain("Project    site (UK, replicated to DE, NY)\n");
  expect(output).toContain("Aliases    example.com, old.example.com");
  expect(output).not.toContain("Storage zone");
  expect(output).not.toContain("Pull zone");
});

test("deploy neither reads nor uploads _redirects and _headers, and says how to migrate them", async () => {
  const dir = await outputDir();
  await writeFile(join(dir, "_redirects"), "/a /b");
  await writeFile(join(dir, "_headers"), "/*\n  Basic-Auth: user:secret");
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const { writes, edgeRuleWrites } = fakeBunny();

  await deploy("key", config(dir));

  expect(writes.filter((w) => /_redirects|_headers/.test(w))).toEqual([]);
  expect(edgeRuleWrites).toEqual([]);
  const output = stripVTControlCharacters(stderr.mock.calls.join(""));
  for (const file of ["_redirects", "_headers"]) {
    expect(output).toContain(
      `${file} is not read. Run \`orbitpush migrate-netlify\` to copy its rules to orbitpush.json.`,
    );
  }
});

test("deploy leaves out the migrate hint once orbitpush.json has rules", async () => {
  const dir = await outputDir();
  await writeFile(join(dir, "_redirects"), "/a /b");
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  fakeBunny();

  await deploy("key", config(dir, "/a /b"));

  const output = stripVTControlCharacters(stderr.mock.calls.join(""));
  expect(output).toContain("_redirects is not read: its rules live in orbitpush.json.");
  expect(output).not.toContain("migrate-netlify");
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

  await expect(deploy("key", config(file))).rejects.toMatchObject({
    code: "ENOTDIR",
  });
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
  const { writes } = fakeBunny({
    edgeRules: [
      { Guid: "keep", Description: kept, OrderIndex: 0 },
      { Guid: "copy", Description: kept, OrderIndex: 0 },
    ],
  });

  await deploy("key", config(dir, "/a /b\n/c /d\n/c /d"));

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

test("deploy serves index.html for unknown paths when redirects have the SPA rule", async () => {
  const dir = await outputDir();
  const { bodies, writes } = fakeBunny();

  await deploy("key", config(dir, "/a /b\n/* /index.html 200"));

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

test("deploy prints the DNS record for each hostname it adds to the pull zone", async () => {
  const dir = await outputDir();
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  fakeBunny({
    hostnames: [
      { Value: "site.b-cdn.net", HasCertificate: true, ForceSSL: true },
      { Value: "www.example.com", HasCertificate: true, ForceSSL: true },
    ],
  });

  await deploy("key", {
    ...config(dir),
    domain: "www.example.com",
    aliases: ["example.com", "old.example.com"],
  });

  const output = stripVTControlCharacters(stderr.mock.calls.join(""));
  expect(output).toMatch(/[^.]example\.com CNAME site\.b-cdn\.net/);
  expect(output).toContain("old.example.com CNAME site.b-cdn.net");
  expect(output).toContain(
    "! Add this DNS record, then run `orbitpush domains add old.example.com` to finish:\n  old.example.com CNAME site.b-cdn.net",
  );
  expect(output).not.toContain("www.example.com CNAME");
});

test("deploy gives one DNS instruction for a hostname it adds before DNS points to it", async () => {
  const dir = await outputDir();
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const { requests } = fakeBunny({ certificateFails: true });

  await deploy("key", { ...config(dir), domain: "www.example.com" });

  expect(domainRequests(requests)).toEqual([
    "POST https://api.bunny.net/pullzone/2/addHostname",
    "GET https://api.bunny.net/pullzone/loadFreeCertificate?hostname=www.example.com",
  ]);
  const output = stripVTControlCharacters(stderr.mock.calls.join(""));
  expect(output).toContain("www.example.com CNAME site.b-cdn.net");
  expect(
    output.split(
      "Add this DNS record, then run `orbitpush domains add www.example.com` to finish:",
    ),
  ).toHaveLength(2);
  expect(output).not.toContain("DNS for www.example.com does not point to bunny.net yet");
  expect(output).not.toContain("No SSL certificate");
});

test("deploy gives no certificate warning for a hostname it just added when the certificate fails for another reason", async () => {
  const dir = await outputDir();
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const { requests } = fakeBunny({
    certificateFails: "CAA record forbids issuance",
  });

  await deploy("key", { ...config(dir), domain: "www.example.com" });

  expect(domainRequests(requests)).toEqual([
    "POST https://api.bunny.net/pullzone/2/addHostname",
    "GET https://api.bunny.net/pullzone/loadFreeCertificate?hostname=www.example.com",
  ]);
  const output = stripVTControlCharacters(stderr.mock.calls.join(""));
  expect(output).toContain("www.example.com CNAME site.b-cdn.net");
  expect(output).not.toContain("No SSL certificate for www.example.com");
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
  expect(stderr.mock.calls.join("")).toContain(
    "DNS for www.example.com does not point to bunny.net",
  );
});

test.each([
  "The domain www.example.com is not pointing to our servers.",
  "THE DOMAIN WWW.EXAMPLE.COM IS NOT POINTING TO OUR SERVERS.",
])("deploy explains the missing DNS record when bunny.net says %s", async (message) => {
  const dir = await outputDir();
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const { requests } = fakeBunny({
    hostnames: [{ Value: "www.example.com", HasCertificate: false, ForceSSL: false }],
    certificateFails: message,
    pullZoneName: "site-cdn",
  });

  await deploy("key", { ...config(dir), domain: "www.example.com" });

  const output = stripVTControlCharacters(stderr.mock.calls.join(""));
  expect(output).toContain(
    "! DNS for www.example.com does not point to bunny.net yet. Add this record, then run `orbitpush domains add www.example.com`:",
  );
  expect(output).toContain("www.example.com CNAME site-cdn.b-cdn.net");
  expect(output).not.toContain("HTTP 400");
  expect(output).not.toContain("loadFreeCertificate");
  expect(requests.some((r) => r.includes("setForceSSL"))).toBe(false);
});

test("deploy passes on bunny.net's reason for any other certificate failure", async () => {
  const dir = await outputDir();
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  fakeBunny({
    hostnames: [{ Value: "www.example.com", HasCertificate: false, ForceSSL: false }],
    certificateFails: "CAA record forbids issuance",
    pullZoneName: "site-cdn",
  });

  await deploy("key", { ...config(dir), domain: "www.example.com" });

  const output = stripVTControlCharacters(stderr.mock.calls.join(""));
  expect(output).toMatch(
    /! No SSL certificate for www\.example\.com yet\. bunny\.net: .*CAA record forbids issuance/,
  );
  expect(output).not.toContain("CNAME");
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
  const [c, a, e] = redirectRules(redirects("/c /d\n/a /b\n/e /f")).rules;
  const { edgeRuleWrites } = fakeBunny({
    edgeRules: [
      { Guid: "a", Description: a.Description, OrderIndex: 0 },
      { Guid: "e", Description: e.Description, OrderIndex: 2 },
    ],
  });

  await deploy("key", config(dir, "/c /d\n/a /b\n/e /f"));

  expect(edgeRuleWrites).toEqual([
    { ...c, OrderIndex: 0 },
    { ...a, Guid: "a", OrderIndex: 1 },
    { ...e, Guid: "e", OrderIndex: 2 },
  ]);
});

test("deploy restores a managed rule edited in the dashboard when the rule files did not change", async () => {
  const dir = await outputDir();
  const [a] = redirectRules(redirects("/a /b")).rules;
  const { edgeRuleWrites } = fakeBunny({
    edgeRules: [{ Guid: "a", Description: a.Description, OrderIndex: 0 }],
  });

  await deploy("key", config(dir, "/a /b"));

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
      {
        Guid: "old",
        Description: "orbitpush 0000000000 /x /y 301",
        OrderIndex: 1,
      },
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

  await deploy("key", {
    ...config(dir),
    domain: "www.example.com",
    aliases: ["Example.COM"],
  });

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
  const { edgeRuleWrites } = fakeBunny({ edgeRules: [] });

  await deploy("key", {
    ...config(dir, "/a /b"),
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
  Triggers: {
    Type: number;
    PatternMatchingType: number;
    PatternMatches: string[];
  }[];
};

async function slashRules(trailingSlash?: Config["trailingSlash"], lines = "/a /b") {
  const dir = await outputDir();
  const { edgeRuleWrites } = fakeBunny({ edgeRules: [] });

  await deploy("key", { ...config(dir, lines), trailingSlash });

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
  expect(rule.Triggers).toContainEqual({
    Type: 6,
    PatternMatchingType: 2,
    PatternMatches: ["*"],
  });
});

const redirectLines = (count: number, prefix = "r") =>
  Array.from({ length: count }, (_, i) => `/${prefix}${i} /b`).join("\n");

test("deploy fails before any write when the rules need a full zone, which bunny.net no longer writes to", async () => {
  const dir = await outputDir();
  const { writes } = fakeBunny({
    edgeRules: [{ Guid: "mine", Description: "created in dashboard", OrderIndex: 0 }],
  });

  await expect(deploy("key", config(dir, redirectLines(49)))).rejects.toThrow(/50 edge rules/);
  expect(writes).toEqual([]);
});

test("deploy accepts 49 edge rules, counting the ones from the dashboard", async () => {
  const dir = await outputDir();
  const { edgeRuleWrites } = fakeBunny({
    edgeRules: [{ Guid: "mine", Description: "created in dashboard", OrderIndex: 0 }],
  });

  await deploy("key", config(dir, redirectLines(48)));

  expect(edgeRuleWrites).toHaveLength(48);
});

test("deploy deletes removed rules first when adding first would fill the zone", async () => {
  const dir = await outputDir();
  const old = redirectRules(redirects(`${redirectLines(48)}\n/gone /b`)).rules;
  const { writes } = fakeBunny({
    edgeRules: old.map((r, i) => ({
      Guid: `g${i}`,
      Description: r.Description,
      OrderIndex: i,
    })),
  });

  await deploy("key", config(dir, `${redirectLines(48)}\n/new /b`));

  const ruleWrites = writes.filter((w) => w.includes("/edgerules/"));
  expect(ruleWrites[0]).toBe("DELETE https://api.bunny.net/pullzone/2/edgerules/g48");
  expect(ruleWrites).toHaveLength(50);
});

test("deploy frees a zone left full by an earlier version once a line is removed", async () => {
  const dir = await outputDir();
  const old = redirectRules(redirects(redirectLines(50))).rules;
  const { writes } = fakeBunny({
    edgeRules: old.map((r, i) => ({
      Guid: `g${i}`,
      Description: r.Description,
      OrderIndex: i,
    })),
  });

  await deploy("key", config(dir, redirectLines(49)));

  const ruleWrites = writes.filter((w) => w.includes("/edgerules/"));
  expect(ruleWrites[0]).toBe("DELETE https://api.bunny.net/pullzone/2/edgerules/g49");
});

test("deploy adds new rules before deleting old ones while the zone has room", async () => {
  const dir = await outputDir();
  const { writes } = fakeBunny();

  await deploy("key", config(dir, "/a /b\n/new /b"));

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
  const { writes } = fakeBunny({
    edgeRules: [{ Guid: "off", Description: "orbitpush disabled", OrderIndex: 0 }],
  });

  await expect(deploy("key", config(dir, redirectLines(49)))).rejects.toThrow(/50 edge rules/);
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

test("deploy warns about a broken symlink and deploys the other files", async () => {
  const dir = await outputDir();
  await symlink(join(dir, "nowhere"), join(dir, "broken"));
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const { writes } = fakeBunny();

  await deploy("key", config(dir));

  expect(stderr.mock.calls.join("")).toMatch(/broken/);
  expect(writes).toContain("PUT https://storage.bunnycdn.com/site/index.html");
  expect(writes).not.toContain("PUT https://storage.bunnycdn.com/site/broken");
});

const zoneHostnames = [
  { Value: "site.b-cdn.net", HasCertificate: true, ForceSSL: false },
  { Value: "www.example.com", HasCertificate: true, ForceSSL: true },
  { Value: "Example.com", HasCertificate: true, ForceSSL: true },
  { Value: "old.example.com", HasCertificate: true, ForceSSL: true },
];

test("deploy warns about a hostname on the pull zone that orbitpush.json no longer lists", async () => {
  const dir = await outputDir();
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const { hostnameRemovals } = fakeBunny({ hostnames: zoneHostnames });

  await deploy("key", {
    ...config(dir),
    domain: "www.example.com",
    aliases: ["example.com"],
  });

  expect(hostnameRemovals).toEqual([]);
  const warnings = stderr.mock.calls.map(String).filter((line) => line.includes("!"));
  expect(warnings.filter((line) => line.includes("old.example.com"))).toHaveLength(1);
  expect(stripVTControlCharacters(stderr.mock.calls.join(""))).toContain(
    "Run `orbitpush domains add old.example.com` to make it an alias, or `orbitpush domains remove old.example.com`.",
  );
  expect(warnings.filter((line) => /b-cdn\.net|www\.example\.com|Example\.com/.test(line))).toEqual(
    [],
  );
});

test("deploy starts no further upload once one has failed", async () => {
  const dir = await outputDir();
  for (let i = 0; i < 20; i++) await writeFile(join(dir, "assets", `f${i}.js`), String(i));
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const { uploads } = fakeBunny({
    slowAssets: true,
    failUpload: "assets/f0.js",
  });

  await expect(deploy("key", config(dir))).rejects.toThrow(/PUT \/assets\/f0\.js failed/);
  await new Promise((resolve) => setTimeout(resolve, 100));

  expect(uploads.filter((u) => u.startsWith("start "))).toHaveLength(8);
});

test.each([
  ["a bunny.net API request", "https://api.bunny.net/storagezone/1", /GET \/storagezone\/1 failed/],
  ["a storage zone listing", "https://storage.bunnycdn.com/site/", /GET \/ failed/],
  ["a stale file deletion", "https://storage.bunnycdn.com/site/gone.html", /DELETE \/gone\.html/],
  ["a stale record read", RECORD_URL, /\.orbitpush\/stale\.json/],
  ["a file upload", "https://storage.bunnycdn.com/site/index.html", /PUT \/index\.html failed/],
])("deploy fails instead of hanging when %s never answers", async (_, url, message) => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(10));
  const dir = await outputDir();
  fakeBunny({
    hang: url,
    staleRecord: { version: 1, stale: { "gone.html": LONG_AGO } },
  });

  await expect(deploy("key", config(dir))).rejects.toThrow(message);
});

test("deploy deletes the old alias redirect before writing the swapped one, so the two never loop", async () => {
  const dir = await outputDir();
  const before = domainRules({
    name: "site",
    domain: "www.example.com",
    aliases: ["example.com"],
  });
  const { writes } = fakeBunny({
    hostnames: [
      { Value: "www.example.com", HasCertificate: true, ForceSSL: true },
      { Value: "example.com", HasCertificate: true, ForceSSL: true },
    ],
    edgeRules: before.map((r, i) => ({
      Guid: `g${i}`,
      Description: r.Description,
      OrderIndex: i,
    })),
  });

  await deploy("key", {
    ...config(dir),
    domain: "example.com",
    aliases: ["www.example.com"],
  });

  const ruleWrites = writes.filter((w) => w.includes("/edgerules/"));
  expect(ruleWrites[0]).toBe("DELETE https://api.bunny.net/pullzone/2/edgerules/g0");
  expect(ruleWrites.slice(1)).toEqual([
    "POST https://api.bunny.net/pullzone/2/edgerules/addOrUpdate",
    "POST https://api.bunny.net/pullzone/2/edgerules/addOrUpdate",
  ]);
});

test("deploy with pruneHostnames removes every hostname orbitpush.json does not list, except b-cdn.net", async () => {
  const dir = await outputDir();
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const { hostnameRemovals } = fakeBunny({
    hostnames: [
      ...zoneHostnames,
      { Value: "Dashboard.example.org", HasCertificate: true, ForceSSL: true },
    ],
  });

  await deploy(
    "key",
    { ...config(dir), domain: "www.example.com", aliases: ["example.com"] },
    { pruneHostnames: true },
  );

  expect(hostnameRemovals).toEqual([
    { Hostname: "old.example.com" },
    { Hostname: "Dashboard.example.org" },
  ]);
  expect(stderr.mock.calls.map(String).filter((line) => line.includes("!"))).toEqual(
    expect.not.arrayContaining([expect.stringMatching(/old\.example\.com|Dashboard/)]),
  );
});

test("deploy with pruneHostnames and no domain removes every custom hostname", async () => {
  const dir = await outputDir();
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const { hostnameRemovals } = fakeBunny({ hostnames: zoneHostnames });

  await deploy("key", config(dir), { pruneHostnames: true });

  expect(hostnameRemovals).toEqual([
    { Hostname: "www.example.com" },
    { Hostname: "Example.com" },
    { Hostname: "old.example.com" },
  ]);
});

async function site(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "orbitpush-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }

  return dir;
}

async function deployOutput(
  files: Record<string, string>,
  overrides: Partial<Config> = {},
  bunny: Parameters<typeof fakeBunny>[0] = {},
) {
  const dir = await site(files);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const { writes, records } = fakeBunny(bunny);

  await deploy("key", { ...config(dir), ...overrides });

  const output = stripVTControlCharacters(stderr.mock.calls.join(""));
  return {
    output,
    writes,
    records,
    puts: writes.filter((w) => w.startsWith("PUT ")),
  };
}

test("deploy counts uploaded, deleted and unchanged files without listing them", async () => {
  const { output } = await deployOutput(
    { "index.html": "new", "assets/app.js": "same", "404.html": "nope" },
    {},
    { staleRecord: { version: 1, stale: { "gone.html": LONG_AGO } } },
  );

  expect(output).toMatch(/^› Files: 2 uploaded, 1 deleted, 1 unchanged$/m);
  for (const path of ["404.html", "index.html", "gone.html", "app.js"]) {
    expect(output).not.toContain(path);
  }
});

test.each([
  [{ "index.html": "<h1>old</h1>", "assets/app.js": "same" }, "1 deleted, 2 unchanged"],
  [{ "index.html": "new" }, "1 uploaded, 2 deleted"],
  [
    { "index.html": "new", "assets/app.js": "changed", "404.html": "nope" },
    "3 uploaded, 1 deleted",
  ],
])("deploy leaves zero counts out of the Files summary for %j", async (files, counts) => {
  const { output } = await deployOutput(
    files,
    {},
    {
      staleRecord: {
        version: 1,
        stale: { "gone.html": LONG_AGO, "assets/app.js": LONG_AGO },
      },
    },
  );

  expect(output).toMatch(new RegExp(`^› Files: ${counts}$`, "m"));
});

test("deploy uploads nothing and lists no file when every file is unchanged", async () => {
  const { output, puts } = await deployOutput({
    "index.html": "<h1>old</h1>",
    "assets/app.js": "same",
  });

  expect(puts.filter((put) => put !== `PUT ${RECORD_URL}`)).toEqual([]);
  expect(output).not.toMatch(/^\s*[+~] /m);
});

test("deploy shows no progress steps without a TTY", async () => {
  const { output } = await deployOutput({ "index.html": "new" }, { redirects: redirects("/c /d") });

  expect(output).toContain("› Files:");
  for (const step of [
    "Comparing with storage zone",
    "Uploading",
    "Applying settings",
    "Purging cache",
  ]) {
    expect(output).not.toContain(step);
  }
});

test("deploy counts added, removed and kept edge rules without listing them", async () => {
  const { output } = await deployOutput(
    { "index.html": "new" },
    { redirects: redirects("/a /b\n/c /d") },
  );

  expect(output).toMatch(/^› Edge rules: 1 added, 1 removed, 1 kept$/m);
  for (const rule of ["/a /b", "/c /d", "/x /y"]) expect(output).not.toContain(rule);
  expect(output.indexOf("› Edge rules:")).toBeGreaterThan(output.indexOf("› Files:"));
});

test("deploy leaves zero counts out of the Edge rules summary", async () => {
  const { output } = await deployOutput(
    { "index.html": "new" },
    { domain: "www.example.com" },
    { edgeRules: [] },
  );

  expect(output).toMatch(/^› Edge rules: 1 added$/m);
});

test("deploy prints no Edge rules summary when there is no managed rule", async () => {
  const { output } = await deployOutput({ "index.html": "new" }, {}, { edgeRules: [] });

  expect(output).toContain("› Files:");
  expect(output).not.toContain("Edge rules");
});

test("deploy writes no alias redirect to a swapped-in domain without a certificate, deletes the old one and warns", async () => {
  const dir = await outputDir();
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const swapped = {
    name: "site",
    domain: "example.com",
    aliases: ["www.example.com"],
  };
  const before = domainRules({
    name: "site",
    domain: "www.example.com",
    aliases: ["example.com"],
  });
  const current = domainRules(swapped).filter((r) => isAliasRule(r.Description));
  const { writes, edgeRuleWrites } = fakeBunny({
    hostnames: [{ Value: "www.example.com", HasCertificate: true, ForceSSL: true }],
    certificateFails: true,
    edgeRules: [...before, ...current].map((r, i) => ({
      Guid: isAliasRule(r.Description) ? `alias${i}` : `g${i}`,
      Description: r.Description,
      OrderIndex: i,
    })),
  });

  await deploy("key", { ...config(dir), ...swapped });

  const written = (edgeRuleWrites as Rule[]).map((r) => r.Description);
  expect(written.filter(isAliasRule)).toEqual([]);
  expect(written).toEqual(
    expect.arrayContaining(
      [...domainRules({ ...swapped, aliases: [] }), ...trailingSlashRule("ignore")].map(
        (r) => r.Description,
      ),
    ),
  );
  for (const [i, r] of [...before, ...current].entries()) {
    if (isAliasRule(r.Description)) {
      expect(writes).toContain(`DELETE https://api.bunny.net/pullzone/2/edgerules/alias${i}`);
    }
  }

  expect(stripVTControlCharacters(stderr.mock.calls.join(""))).toContain(
    "! www.example.com will redirect to example.com once it has HTTPS. Run `orbitpush domains add example.com` to finish it.",
  );
});

test("deploy writes the alias redirects once it gets the domain a certificate in this run", async () => {
  const dir = await outputDir();
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const target = {
    name: "site",
    domain: "example.com",
    aliases: ["www.example.com", "example.net"],
  };
  const { requests, edgeRuleWrites } = fakeBunny({
    hostnames: [{ Value: "www.example.com", HasCertificate: true, ForceSSL: true }],
    edgeRules: [],
  });

  await deploy("key", { ...config(dir), ...target });

  expect(requests).toContain(
    "GET https://api.bunny.net/pullzone/loadFreeCertificate?hostname=example.com",
  );
  expect((edgeRuleWrites as Rule[]).map((r) => r.Description).filter(isAliasRule)).toEqual(
    domainRules(target)
      .map((r) => r.Description)
      .filter(isAliasRule),
  );
  expect(stderr.mock.calls.join("")).not.toContain("will redirect to");
});

test("deploy gives no alias warning for a domain without a certificate when there are no aliases", async () => {
  const dir = await outputDir();
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  fakeBunny({
    hostnames: [{ Value: "example.com", HasCertificate: false, ForceSSL: false }],
    certificateFails: true,
  });

  await deploy("key", { ...config(dir), domain: "example.com" });

  const output = stderr.mock.calls.join("");
  expect(output).toContain("does not point to bunny.net");
  expect(output).not.toContain("will redirect to");
});

const deployed = {
  "index.html": "new",
  "assets/app.js": "same",
  "404.html": "nope",
};
const deletes = (writes: string[]) => writes.filter((w) => w.startsWith("DELETE https://storage"));

test("deploy keeps every stale file on the first deploy and records it as stale since now", async () => {
  freezeTime();
  const dir = await outputDir();
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const { writes, records } = fakeBunny();

  await deploy("key", config(dir, "/a /b\n/c /d"));

  expect(deletes(writes)).toEqual([]);
  expect(records).toEqual([{ version: 1, stale: { "gone.html": NOW.toISOString() } }]);
  expect(writes.slice(-3)).toEqual([
    "DELETE https://api.bunny.net/pullzone/2/edgerules/old",
    `PUT ${RECORD_URL}`,
    "POST https://api.bunny.net/pullzone/2/purgeCache",
  ]);
});

test("deploy counts a stale file it keeps as kept", async () => {
  const { output } = await deployOutput(deployed);

  expect(output).toMatch(/^› Files: 2 uploaded, 1 kept, 1 unchanged$/m);
});

test.each([
  ["not JSON", "{not json"],
  ["an unknown version", JSON.stringify({ version: 2, stale: {} })],
  ["no stale map", JSON.stringify({ version: 1 })],
  [
    "a date that is not a date",
    JSON.stringify({ version: 1, stale: { "gone.html": "yesterday" } }),
  ],
])("deploy fails before any write when the stale record is %s", async (_, body) => {
  const dir = await outputDir();
  const { writes } = fakeBunny({ staleRecord: body });

  await expect(deploy("key", config(dir))).rejects.toThrow(
    /^bunny\.net returned an unexpected response for/,
  );
  expect(writes).toEqual([]);
});

test.each([
  ["keeps", 7 * DAY, []],
  ["deletes", 7 * DAY + 1, ["DELETE https://storage.bunnycdn.com/site/gone.html"]],
])("deploy %s a stale file stale for %i ms", async (_, age, expected) => {
  freezeTime();
  const { writes } = await deployOutput(
    deployed,
    {},
    {
      staleRecord: { version: 1, stale: { "gone.html": ago(age) } },
    },
  );

  expect(deletes(writes)).toEqual(expected);
});

test("deploy keeps the original date of a stale file it keeps while recording a new one", async () => {
  freezeTime();
  const since = ago(3 * DAY);
  const { writes, records } = await deployOutput(
    { "index.html": "new" },
    {},
    { staleRecord: { version: 1, stale: { "gone.html": since } } },
  );

  expect(deletes(writes)).toEqual([]);
  expect(records).toEqual([
    {
      version: 1,
      stale: { "gone.html": since, "assets/app.js": NOW.toISOString() },
    },
  ]);
});

test("deploy writes no stale record when its content does not change", async () => {
  freezeTime();
  const { puts } = await deployOutput(
    deployed,
    {},
    {
      staleRecord: {
        version: 1,
        stale: { "gone.html": ago(DAY) },
      },
    },
  );

  expect(puts).not.toContain(`PUT ${RECORD_URL}`);
});

test("deploy writes no stale record when there is neither a stale file nor a record", async () => {
  const { puts } = await deployOutput({ ...deployed, "gone.html": "X" });

  expect(puts).not.toContain(`PUT ${RECORD_URL}`);
});

test("deploy drops a path that is back in the build from the stale record without deleting it", async () => {
  const { writes, records } = await deployOutput(
    deployed,
    {},
    {
      staleRecord: {
        version: 1,
        stale: { "index.html": LONG_AGO, "gone.html": LONG_AGO },
      },
    },
  );

  expect(deletes(writes)).toEqual(["DELETE https://storage.bunnycdn.com/site/gone.html"]);
  expect(records).toEqual([{ version: 1, stale: {} }]);
});

test("deploy drops stale record entries for paths no longer in the storage zone", async () => {
  freezeTime();
  const since = ago(DAY);
  const { writes, records } = await deployOutput(
    deployed,
    {},
    {
      staleRecord: {
        version: 1,
        stale: { "gone.html": since, "vanished.js": LONG_AGO },
      },
    },
  );

  expect(deletes(writes)).toEqual([]);
  expect(records).toEqual([{ version: 1, stale: { "gone.html": since } }]);
});

const withOrbitpushFolder = {
  "": [...defaultListing[""], folder(".orbitpush")],
  "assets/": defaultListing["assets/"],
  ".orbitpush/": [object("stale.json"), object("other.json")],
};

test("deploy never deletes, records or counts files under .orbitpush/", async () => {
  const { output, writes, records } = await deployOutput(
    deployed,
    {},
    {
      listing: withOrbitpushFolder,
      staleRecord: { version: 1, stale: { "gone.html": LONG_AGO } },
    },
  );

  expect(deletes(writes)).toEqual(["DELETE https://storage.bunnycdn.com/site/gone.html"]);
  expect(records).toEqual([{ version: 1, stale: {} }]);
  expect(output).toMatch(/^› Files: 2 uploaded, 1 deleted, 1 unchanged$/m);
});

test("deploy leaves files under .orbitpush/ out of a new stale record", async () => {
  freezeTime();
  const { output, records } = await deployOutput(deployed, {}, { listing: withOrbitpushFolder });

  expect(records).toEqual([{ version: 1, stale: { "gone.html": NOW.toISOString() } }]);
  expect(output).toMatch(/^› Files: 2 uploaded, 1 kept, 1 unchanged$/m);
});
