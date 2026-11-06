import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import {
  migrateNetlify,
  parseHeadersFile,
  parseNetlifyToml,
  parseRedirectsFile,
} from "../src/commands/migrate-netlify.ts";
import { headerRules, redirectRules } from "../src/rules.ts";

const cwd = process.cwd();
const e2eSites = resolve("e2e/sites");
const base = {
  name: "s",
  outputDir: "public",
  region: "DE",
  replicationRegions: [],
  geoZones: ["EU"],
  storageZoneId: 1,
  pullZoneId: 2,
};
let stderr = "";

const setup = async (config: object = base) => {
  await writeFile("orbitpush.json", JSON.stringify(config));
  await mkdir("public");
};

const message = (promise: Promise<unknown>) =>
  promise.then(
    () => "",
    (caught: unknown) => (caught instanceof Error ? caught.message : ""),
  );

beforeEach(async () => {
  process.chdir(await mkdtemp(join(tmpdir(), "orbitpush-migrate-")));
  stderr = "";
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(cwd);
});

test("writes the rules of all three sources into orbitpush.json in Netlify's order and keeps everything else", async () => {
  await setup({ ...base, domain: "www.example.com", aliases: [] });
  const sources = {
    "public/_redirects": "/a /b\n",
    "public/_headers": "/*\n  X-From: file\n",
    "netlify.toml": [
      "[[redirects]]",
      'from = "/c"',
      'to = "/d"',
      "status = 302",
      "",
      "[[headers]]",
      'for = "/x"',
      "[headers.values]",
      'X-From = "toml"',
      "",
    ].join("\n"),
  };
  for (const [path, text] of Object.entries(sources)) await writeFile(path, text);

  await migrateNetlify();

  expect(JSON.parse(await readFile("orbitpush.json", "utf8"))).toEqual({
    $schema: "https://unpkg.com/orbitpush/schema.json",
    ...base,
    domain: "www.example.com",
    aliases: [],
    redirects: [
      { from: "/a", to: "/b", status: 301 },
      { from: "/c", to: "/d", status: 302 },
    ],
    headers: [
      { for: "/*", values: { "X-From": "file" } },
      { for: "/x", values: { "X-From": "toml" } },
    ],
  });
  for (const [path, text] of Object.entries(sources)) {
    expect(await readFile(path, "utf8")).toBe(text);
  }
});

test("reads _redirects lines with query params, forced status and conditions", () => {
  const text = [
    "# comment",
    "",
    "/old /new",
    "/search id=:id /items/:id 302!",
    "/de /de/home 302 Country=de,at Language=en",
    "/nowhere",
  ].join("\n");

  const { redirects, warnings } = parseRedirectsFile(text);

  expect(redirects).toEqual([
    { from: "/old", to: "/new", status: 301 },
    { from: "/search", to: "/items/:id", status: 302, force: true, query: { id: ":id" } },
    {
      from: "/de",
      to: "/de/home",
      status: 302,
      conditions: { Country: ["de", "at"], Language: ["en"] },
    },
  ]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("_redirects:6");
});

test("migrates a _redirects line whose condition lists no value without the condition", async () => {
  await setup();
  await writeFile("public/_redirects", "/a /b 302 Country=,\n");

  await migrateNetlify();

  const written = JSON.parse(await readFile("orbitpush.json", "utf8"));
  expect(written.redirects).toEqual([{ from: "/a", to: "/b", status: 302 }]);
});

test("joins a repeated header in _headers under its first spelling", () => {
  const text = "/*\n  Cache-Control: no-cache\n  cache-control: must-revalidate\n  X-A: 1\n";

  expect(parseHeadersFile(text)).toEqual({
    redirects: [],
    headers: [{ for: "/*", values: { "Cache-Control": "no-cache, must-revalidate", "X-A": "1" } }],
    warnings: [],
  });
});

test("never copies Basic-Auth from _headers or shows its password", async () => {
  await setup();
  await writeFile("public/_headers", "/admin/*\n  Basic-Auth: alice:s3cretpw\n  X-A: 1\n");

  await migrateNetlify();

  const written = await readFile("orbitpush.json", "utf8");
  expect(JSON.parse(written).headers).toEqual([{ for: "/admin/*", values: { "X-A": "1" } }]);
  expect(written).not.toContain("s3cretpw");
  expect(stderr).toMatch(/Basic-Auth/);
  expect(stderr).not.toContain("s3cretpw");
});

test("skips a _headers path without header lines, with a warning", () => {
  const { headers, warnings } = parseHeadersFile("/empty\n/b\n  X-B: 2\n");

  expect(headers).toEqual([{ for: "/b", values: { "X-B": "2" } }]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("/empty");
});

test("keeps the supported [[redirects]] keys from netlify.toml and skips one without to", () => {
  const text = [
    "[[redirects]]",
    'from = "/a"',
    'to = "/b"',
    "force = true",
    'signed = "SECRET"',
    'query = { id = ":id" }',
    'conditions = { Country = ["de"] }',
    'headers = { X-Y = "z" }',
    "",
    "[[redirects]]",
    'from = "/lost"',
    "",
  ].join("\n");

  const { redirects, warnings } = parseNetlifyToml(text);

  expect(redirects).toEqual([
    {
      from: "/a",
      to: "/b",
      status: 301,
      force: true,
      query: { id: ":id" },
      conditions: { Country: ["de"] },
    },
  ]);
  expect(warnings).toHaveLength(1);
});

test("joins a multi-line header value from netlify.toml and drops Basic-Auth", () => {
  const text = [
    "[[headers]]",
    'for = "/*"',
    "[headers.values]",
    "Cache-Control = '''",
    "  max-age=0,",
    "  no-cache'''",
    'Basic-Auth = "bob:hunter22"',
    "",
  ].join("\n");

  const { headers, warnings } = parseNetlifyToml(text);

  expect(headers).toEqual([{ for: "/*", values: { "Cache-Control": "max-age=0, no-cache" } }]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatch(/Basic-Auth/);
  expect(warnings[0]).not.toContain("hunter22");
});

test("rejects invalid TOML", () => {
  expect(() => parseNetlifyToml("[[redirects]\nfrom = ")).toThrow(/^Invalid netlify\.toml/);
});

test("writes rules bunny.net cannot serve and warns about them", async () => {
  await setup();
  await writeFile("public/_redirects", "/app/* /index.html 200\n/en /en/ 302 Language=en\n");

  await migrateNetlify();

  expect(JSON.parse(await readFile("orbitpush.json", "utf8")).redirects).toEqual([
    { from: "/app/*", to: "/index.html", status: 200 },
    { from: "/en", to: "/en/", status: 302, conditions: { Language: ["en"] } },
  ]);
  expect(stderr).not.toBe("");
});

test("refuses to overwrite redirects or headers already in orbitpush.json", async () => {
  const existing = JSON.stringify({ ...base, headers: [{ for: "/*", values: { "X-A": "1" } }] });
  await setup();
  await writeFile("orbitpush.json", existing);
  await writeFile("public/_redirects", "/a /b\n");

  expect(await message(migrateNetlify())).toContain("already has redirects or headers");
  expect(await readFile("orbitpush.json", "utf8")).toBe(existing);
});

test("reports nothing to migrate when no source file exists", async () => {
  await setup();
  const before = await readFile("orbitpush.json", "utf8");

  expect(await message(migrateNetlify())).toMatch(/^Nothing to migrate/);
  expect(await readFile("orbitpush.json", "utf8")).toBe(before);
});

test("needs orbitpush.json", async () => {
  await writeFile("netlify.toml", '[[redirects]]\nfrom = "/a"\nto = "/b"\n');

  await expect(migrateNetlify()).rejects.toThrow(/orbitpush\.json not found/);
});

test("migrates the multi-page e2e site into the rules its e2e tests expect", async () => {
  await setup({ ...base, aliases: [] });
  const fill = (text: string) =>
    text.replaceAll("{{domain}}", "www.example.com").replaceAll("{{country}}", "de");
  for (const file of ["_redirects", "_headers"]) {
    const text = await readFile(join(e2eSites, "multi-page", file), "utf8");
    await writeFile(join("public", file), fill(text));
  }
  const toml = await readFile(join(e2eSites, "multi-page.netlify.toml"), "utf8");
  await writeFile("netlify.toml", fill(toml));

  await migrateNetlify();

  const { redirects, headers } = JSON.parse(await readFile("orbitpush.json", "utf8"));
  expect(redirects.map((r: { from: string; to: string }) => `${r.from} ${r.to}`)).toEqual([
    "/old /pricing.html",
    "/blog/:year/:slug /guides/:slug",
    "/handbook/* /guides/:splat",
    "/moved /contact.html",
    "/first /pricing.html",
    "/proxy /contact.html",
    "https://www.example.com/domain-only /pricing.html",
    "/shadowed.html /pricing.html",
    "/temp /contact.html",
    "/geo-here /pricing.html",
    "/geo-many /pricing.html",
    "/first /contact.html",
    "/geo /contact.html",
  ]);
  expect(redirects[7]).toMatchObject({ status: 301, force: true });
  expect(redirects[12]).toEqual({
    from: "/geo",
    to: "/contact.html",
    status: 302,
    conditions: { Country: ["aq"] },
  });
  expect(headers[0].values).toMatchObject({ "X-E2E-Multi": "a, b" });
  expect(headers.at(-1)).toEqual({
    for: "/pricing.html",
    values: {
      "Set-Cookie": "e2e=1; Path=/",
      "cache-control": "max-age=0, no-cache",
      "Content-Length": "1",
      Server: "e2e",
    },
  });
  expect(await readFile("orbitpush.json", "utf8")).not.toContain("e2e-secret");
  expect(stderr).not.toContain("e2e-secret");
  expect(redirectRules(redirects).rules).toHaveLength(13);
  expect(headerRules(headers).rules).toHaveLength(7);
});
