import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { type Config, readConfig, writeConfig } from "../src/config.ts";
import { Cancelled, domains } from "../src/commands/domains.ts";
import { domainRules, isAliasRule } from "../src/rules.ts";

const cwd = process.cwd();
const API = "https://api.bunny.net";
let stderr: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  process.chdir(await mkdtemp(join(tmpdir(), "orbitpush-domains-")));
  stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  process.chdir(cwd);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const output = () => stripVTControlCharacters(stderr.mock.calls.join(""));

async function site(over: Partial<Config> = {}): Promise<Config> {
  const config: Config = {
    name: "site",
    outputDir: "dist",
    aliases: [],
    region: "DE",
    replicationRegions: [],
    geoZones: ["EU"],
    trailingSlash: "ignore",
    redirects: [],
    headers: [],
    storageZoneId: 1,
    pullZoneId: 2,
    ...over,
  };
  await writeConfig(config);
  return config;
}

type Hostname = { Value: string; HasCertificate: boolean; ForceSSL: boolean };
type Rule = { Guid: string; Description: string | null; OrderIndex: number };

const connected = (Value: string): Hostname => ({ Value, HasCertificate: true, ForceSSL: true });

const deployedRules = (config: { domain?: string; aliases: string[] }): Rule[] =>
  domainRules({ name: "site", ...config }).map((r, i) => ({
    Guid: isAliasRule(r.Description) ? `alias-${r.Description.split(" ")[3]}` : `rule${i}`,
    Description: r.Description,
    OrderIndex: i,
  }));

const STALE: Rule = { Guid: "stale", Description: "orbitpush 0000000000 /x /y 301", OrderIndex: 9 };
const DASHBOARD: Rule = { Guid: "mine", Description: "created in dashboard", OrderIndex: 10 };

function fakeBunny({
  hostnames = [] as Hostname[],
  edgeRules = [] as Rule[],
  dns = new Set<string>(),
  dnsFromCheck = Infinity,
  certificateError,
  refuse = new Set<string>(),
}: {
  hostnames?: Hostname[];
  edgeRules?: Rule[];
  dns?: Set<string>;
  dnsFromCheck?: number;
  certificateError?: string;
  refuse?: Set<string>;
} = {}) {
  const zone = { hostnames: [...hostnames], rules: [...edgeRules] };
  const requests: string[] = [];
  const writes: string[] = [];
  const bodies: Record<string, unknown[]> = {};
  const certificateChecks: number[] = [];
  let guid = 0;

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = input instanceof Request ? input.url : input.toString();
    const method = init.method ?? "GET";
    const key = `${method} ${url}`;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

    requests.push(key);
    if (method !== "GET") writes.push(key);
    if (body !== undefined) (bodies[key] ??= []).push(body);
    if (refuse.has(key)) return json({ Message: "Internal error" }, 500);

    if (key === `GET ${API}/pullzone/2`) {
      return json({ Id: 2, Name: "site", Hostnames: zone.hostnames, EdgeRules: zone.rules });
    }

    if (url.startsWith(`${API}/pullzone/loadFreeCertificate?`)) {
      const host = new URL(url).searchParams.get("hostname") ?? "";
      certificateChecks.push(Date.now());
      if (certificateError) return json({ Message: certificateError }, 400);
      if (!dns.has(host) && certificateChecks.length < dnsFromCheck) {
        return json({ Message: `The domain ${host} is not pointing to our servers.` }, 400);
      }
      const entry = zone.hostnames.find((h) => h.Value === host);
      if (entry) entry.HasCertificate = true;
      return new Response(null, { status: 200 });
    }

    if (key === `POST ${API}/pullzone/2/addHostname`) {
      zone.hostnames.push({ Value: body.Hostname, HasCertificate: false, ForceSSL: false });
    }
    if (key === `POST ${API}/pullzone/2/setForceSSL`) {
      const entry = zone.hostnames.find((h) => h.Value === body.Hostname);
      if (entry) entry.ForceSSL = body.ForceSSL;
    }
    if (key === `DELETE ${API}/pullzone/2/removeHostname`) {
      zone.hostnames = zone.hostnames.filter((h) => h.Value !== body.Hostname);
    }
    if (key === `POST ${API}/pullzone/2/edgerules/addOrUpdate`) {
      const Guid = body.Guid ?? `new${guid++}`;
      zone.rules = [...zone.rules.filter((r) => r.Guid !== Guid), { ...body, Guid }];
    }
    if (method === "DELETE" && url.startsWith(`${API}/pullzone/2/edgerules/`)) {
      zone.rules = zone.rules.filter((r) => !url.endsWith(`/${r.Guid}`));
    }

    return new Response(null, { status: 200 });
  });

  const ruleWrites = () => (bodies[`POST ${API}/pullzone/2/edgerules/addOrUpdate`] ?? []) as Rule[];

  return { zone, requests, writes, bodies, certificateChecks, ruleWrites };
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

const fileText = () => readFile("orbitpush.json", "utf8");
const aliasRule = (alias: string, domain: string) =>
  expect.stringMatching(new RegExp(`^orbitpush [0-9a-f]{10} alias ${alias} ${domain}$`));
const options = { interactive: false };

test("add makes the first hostname the primary domain, lowercased, and connects it", async () => {
  const config = await site();
  const { writes, bodies, ruleWrites, zone } = fakeBunny({
    dns: new Set(["www.example.com"]),
    edgeRules: [STALE, DASHBOARD],
  });

  const result = await domains("key", config, ["add", "WWW.Example.com"], options);

  expect(result).toBeUndefined();

  expect(await readConfig()).toMatchObject({ domain: "www.example.com", aliases: [] });
  expect(writes).toEqual([
    `POST ${API}/pullzone/2/addHostname`,
    `POST ${API}/pullzone/2/setForceSSL`,
    `POST ${API}/pullzone/2`,
    `POST ${API}/pullzone/2/edgerules/addOrUpdate`,
    `DELETE ${API}/pullzone/2/edgerules/stale`,
    `POST ${API}/pullzone/2/purgeCache`,
  ]);
  expect(bodies[`POST ${API}/pullzone/2/addHostname`]).toEqual([{ Hostname: "www.example.com" }]);
  expect(bodies[`POST ${API}/pullzone/2/setForceSSL`]).toEqual([
    { Hostname: "www.example.com", ForceSSL: true },
  ]);
  expect(bodies[`POST ${API}/pullzone/2`]).toEqual([{ EnableHostnameVary: true }]);
  expect(ruleWrites().map((r) => r.Description)).toEqual(
    domainRules({ name: "site", domain: "www.example.com", aliases: [] }).map((r) => r.Description),
  );
  expect(zone.rules).toContainEqual(DASHBOARD);
  expect(output()).toContain("✔ www.example.com is connected: https://www.example.com");
});

test("add rejects an invalid hostname without sending or writing anything", async () => {
  const config = await site();
  const before = await fileText();
  const { requests } = fakeBunny();

  await expect(domains("key", config, ["add", "not a host"], options)).rejects.toThrow(
    /^Invalid hostname: /,
  );

  expect(requests).toEqual([]);
  expect(await fileText()).toBe(before);
});

test("add appends an alias that redirects to the connected primary domain", async () => {
  const config = await site({ domain: "www.example.com", aliases: ["example.net"] });
  const { writes, ruleWrites } = fakeBunny({
    hostnames: [connected("www.example.com"), connected("example.net")],
    edgeRules: deployedRules(config),
    dns: new Set(["example.com"]),
  });

  await domains("key", config, ["add", "example.com"], options);

  expect(await readConfig()).toMatchObject({
    domain: "www.example.com",
    aliases: ["example.net", "example.com"],
  });
  expect(ruleWrites().map((r) => r.Description)).toContainEqual(
    aliasRule("example\\.com", "www\\.example\\.com"),
  );
  expect(writes).toContain(`POST ${API}/pullzone/2/purgeCache`);
  expect(output()).toContain("✔ example.com is connected and redirects to www.example.com");
});

test("add skips what the pull zone already has: the hostname, and ForceSSL once it is on", async () => {
  const config = await site({ domain: "www.example.com" });
  const { requests, writes } = fakeBunny({
    hostnames: [{ Value: "www.example.com", HasCertificate: false, ForceSSL: true }],
    dns: new Set(["www.example.com"]),
  });

  await domains("key", config, ["add", "www.example.com"], options);

  expect(requests).toContain(`GET ${API}/pullzone/loadFreeCertificate?hostname=www.example.com`);
  expect(writes).not.toContain(`POST ${API}/pullzone/2/addHostname`);
  expect(writes).not.toContain(`POST ${API}/pullzone/2/setForceSSL`);
});

test("add of a hostname that is already connected and in sync lists it once and purges nothing", async () => {
  const config = await site({ domain: "www.example.com", aliases: ["example.com"] });
  const { requests, writes } = fakeBunny({
    hostnames: [connected("www.example.com"), connected("example.com")],
    edgeRules: deployedRules(config),
  });

  await domains("key", config, ["add", "example.com"], options);

  expect((await readConfig()).aliases).toEqual(["example.com"]);
  expect(requests.filter((r) => /addHostname|loadFreeCertificate|setForceSSL/.test(r))).toEqual([]);
  expect(writes).not.toContain(`POST ${API}/pullzone/2/purgeCache`);
});

test("add refuses one alias too many without sending a write or changing orbitpush.json", async () => {
  const aliases = Array.from({ length: 8 }, (_, i) => `a${i}.example.com`);
  const config = await site({ domain: "www.example.com", aliases });
  const before = await fileText();
  const { writes } = fakeBunny();

  await expect(domains("key", config, ["add", "a8.example.com"], options)).rejects.toThrow(
    /at most 8 aliases/,
  );

  expect(writes).toEqual([]);
  expect(await fileText()).toBe(before);
});

test("add without a terminal prints the DNS record, checks once and fails, keeping the domain in orbitpush.json", async () => {
  const config = await site();
  const { writes, certificateChecks } = fakeBunny();

  const error = await domains("key", config, ["add", "example.com"], options).catch(
    (e: unknown) => e,
  );

  expect(String(error)).toContain("is not connected yet");
  expect(String(error)).toContain("orbitpush domains add example.com");
  expect(String(error)).toContain("again in a few minutes");
  expect(certificateChecks).toHaveLength(1);
  expect(writes).toEqual([`POST ${API}/pullzone/2/addHostname`]);
  expect(await readConfig()).toMatchObject({ domain: "example.com" });
  expect(output()).toContain("! Add this DNS record at your DNS provider:");
  expect(output()).toContain("example.com CNAME site.b-cdn.net");
  expect(output()).toMatch(/ALIAS|ANAME|CNAME flattening/);
});

test("add in a terminal rechecks DNS every 10 seconds and connects on success", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const config = await site();
  const { certificateChecks, writes, requests } = fakeBunny({ dnsFromCheck: 6 });

  const done = domains("key", config, ["add", "www.example.com"], { interactive: true });
  await settleWithFakeTimers(done);

  const seconds = certificateChecks.map((t) => (t - certificateChecks[0]) / 1000);
  expect(seconds).toEqual([0, 10, 20, 30, 40, 50]);
  expect(requests.indexOf(`POST ${API}/pullzone/2/setForceSSL`)).toBeGreaterThan(
    requests.lastIndexOf(`GET ${API}/pullzone/loadFreeCertificate?hostname=www.example.com`),
  );
  expect(writes).toContain(`POST ${API}/pullzone/2/purgeCache`);
  expect(output()).toContain("www.example.com CNAME site.b-cdn.net");
  expect(output()).not.toMatch(/ALIAS|ANAME|flattening/);
  expect(output()).toContain("✔ www.example.com is connected: https://www.example.com");
});

test("add in a terminal gives up after 15 minutes", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const config = await site();
  const { certificateChecks, writes } = fakeBunny();

  const error = await settleWithFakeTimers(
    domains("key", config, ["add", "www.example.com"], { interactive: true }).catch(
      (e: unknown) => e,
    ),
  );
  const failedAfter = (Date.now() - certificateChecks[0]) / 1000;

  expect(String(error)).toContain("is not connected yet");
  expect(String(error)).toContain("orbitpush domains add www.example.com");
  const seconds = certificateChecks.map((t) => (t - certificateChecks[0]) / 1000);
  expect(seconds.slice(0, 4)).toEqual([0, 10, 20, 30]);
  expect(seconds.at(-1)).toBeGreaterThanOrEqual(14 * 60);
  expect(failedAfter).toBeLessThanOrEqual(15 * 60);
  expect(writes).not.toContain(`POST ${API}/pullzone/2/setForceSSL`);
});

test("add fails at once with bunny.net's message when the certificate fails for another reason", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const config = await site();
  const { certificateChecks } = fakeBunny({ certificateError: "Rate limit exceeded for example" });

  const error = await settleWithFakeTimers(
    domains("key", config, ["add", "www.example.com"], { interactive: true }).catch(
      (e: unknown) => e,
    ),
  );

  expect(String(error)).toContain("Rate limit exceeded for example");
  expect(certificateChecks).toHaveLength(1);
});

test("an alias that connects while the primary domain has no certificate gets no redirect yet", async () => {
  const config = await site({ domain: "www.example.com" });
  const { ruleWrites } = fakeBunny({
    hostnames: [{ Value: "www.example.com", HasCertificate: false, ForceSSL: false }],
    dns: new Set(["example.com"]),
  });

  await domains("key", config, ["add", "example.com"], options);

  expect(ruleWrites().length).toBeGreaterThan(0);
  expect(ruleWrites().filter((r) => isAliasRule(r.Description))).toEqual([]);
  expect(output()).toContain("will redirect to www.example.com once it has HTTPS");
});

test("add --primary on the primary domain changes nothing", async () => {
  const config = await site({ domain: "www.example.com" });
  const before = await fileText();
  const { writes } = fakeBunny({ hostnames: [connected("www.example.com")] });

  await domains("key", config, ["add", "www.example.com"], { primary: true, interactive: false });

  expect(writes).toEqual([]);
  expect(await fileText()).toBe(before);
  expect(output()).toContain("✔ www.example.com is already the primary domain");
});

test("add --primary swaps a connected alias with the primary domain and turns the redirects around", async () => {
  const config = await site({ domain: "www.example.com", aliases: ["example.com", "example.net"] });
  const { writes, ruleWrites } = fakeBunny({
    hostnames: [connected("www.example.com"), connected("example.com"), connected("example.net")],
    edgeRules: deployedRules(config),
  });

  await domains("key", config, ["add", "example.com"], { primary: true, interactive: false });

  expect(await readConfig()).toMatchObject({
    domain: "example.com",
    aliases: ["www.example.com", "example.net"],
  });
  const aliasWrites = ruleWrites()
    .map((r) => r.Description)
    .filter(isAliasRule);
  expect(aliasWrites).toEqual(
    expect.arrayContaining([
      aliasRule("www\\.example\\.com", "example\\.com"),
      aliasRule("example\\.net", "example\\.com"),
    ]),
  );
  expect(aliasWrites).toHaveLength(2);
  expect(writes).toContain(`DELETE ${API}/pullzone/2/edgerules/alias-example.com`);
  expect(writes).toContain(`DELETE ${API}/pullzone/2/edgerules/alias-example.net`);
  expect(output()).toContain("example.com is now the primary domain.");
  expect(output()).toMatch(/www\.example\.com.*redirect to it/);
});

test("add --primary keeps a hostname that does not connect as an alias", async () => {
  const config = await site({ domain: "www.example.com" });
  fakeBunny({ hostnames: [connected("www.example.com")] });

  const error = await domains("key", config, ["add", "new.example.com"], {
    primary: true,
    interactive: false,
  }).catch((e: unknown) => e);

  expect(String(error)).toContain("It stays an alias for now");
  expect(String(error)).toContain("orbitpush domains add new.example.com --primary");
  expect(await readConfig()).toMatchObject({
    domain: "www.example.com",
    aliases: ["new.example.com"],
  });
});

test("remove refuses a primary domain that still has aliases", async () => {
  const config = await site({ domain: "www.example.com", aliases: ["example.com"] });
  const before = await fileText();
  const { writes } = fakeBunny({ hostnames: [connected("www.example.com")] });

  await expect(domains("key", config, ["remove", "www.example.com"], options)).rejects.toThrow(
    /has aliases that redirect to it/,
  );

  expect(writes).toEqual([]);
  expect(await fileText()).toBe(before);
});

test("remove refuses a hostname that is neither in orbitpush.json nor on the pull zone", async () => {
  const config = await site({ domain: "www.example.com" });
  const { writes } = fakeBunny({ hostnames: [connected("www.example.com")] });

  await expect(domains("key", config, ["remove", "other.example.com"], options)).rejects.toThrow(
    /is not a domain of this site/,
  );

  expect(writes).toEqual([]);
});

test("remove takes an alias off orbitpush.json, the pull zone and its redirect", async () => {
  const config = await site({ domain: "www.example.com", aliases: ["example.com", "example.net"] });
  const { writes, bodies } = fakeBunny({
    hostnames: [connected("www.example.com"), connected("example.com"), connected("example.net")],
    edgeRules: deployedRules(config),
  });

  const result = await domains("key", config, ["remove", "Example.com"], options);

  expect(result).toBeUndefined();

  expect(await readConfig()).toMatchObject({
    domain: "www.example.com",
    aliases: ["example.net"],
  });
  expect(bodies[`DELETE ${API}/pullzone/2/removeHostname`]).toEqual([{ Hostname: "example.com" }]);
  expect(writes).toContain(`DELETE ${API}/pullzone/2/edgerules/alias-example.com`);
  expect(writes).not.toContain(`DELETE ${API}/pullzone/2/edgerules/alias-example.net`);
  expect(writes).toContain(`POST ${API}/pullzone/2/purgeCache`);
  expect(output()).toContain("✔ Removed example.com. It no longer serves the site.");
});

test("remove of the last domain clears domain and deletes the noindex rule", async () => {
  const config = await site({ domain: "www.example.com" });
  const rules = deployedRules(config);
  const { writes, zone } = fakeBunny({
    hostnames: [connected("www.example.com")],
    edgeRules: [...rules, DASHBOARD],
  });

  await domains("key", config, ["remove", "www.example.com"], options);

  expect((await readConfig()).domain).toBeUndefined();
  expect(writes).toContain(`DELETE ${API}/pullzone/2/removeHostname`);
  for (const rule of rules)
    expect(writes).toContain(`DELETE ${API}/pullzone/2/edgerules/${rule.Guid}`);
  expect(zone.rules).toEqual([DASHBOARD]);
});

test("remove of a hostname only on the pull zone removes it there", async () => {
  const config = await site({ domain: "www.example.com" });
  const { bodies } = fakeBunny({
    hostnames: [connected("www.example.com"), connected("leftover.example.com")],
    edgeRules: deployedRules(config),
  });

  await domains("key", config, ["remove", "leftover.example.com"], options);

  expect(bodies[`DELETE ${API}/pullzone/2/removeHostname`]).toEqual([
    { Hostname: "leftover.example.com" },
  ]);
  expect((await readConfig()).domain).toBe("www.example.com");
});

test("list shows each domain's state and changes nothing", async () => {
  const config = await site({
    domain: "www.example.com",
    aliases: ["example.com", "example.net", "example.org"],
  });
  const { requests } = fakeBunny({
    hostnames: [
      { Value: "site.b-cdn.net", HasCertificate: true, ForceSSL: false },
      connected("www.example.com"),
      connected("example.com"),
      { Value: "example.net", HasCertificate: false, ForceSSL: false },
      connected("stray.example.com"),
    ],
  });

  await domains("key", config, ["list"], options);

  expect(requests.every((r) => r.startsWith("GET "))).toBe(true);
  const lines = output().split("\n");
  const line = (host: string) => lines.find((l) => l.includes(` ${host} `)) ?? "";
  expect(line("www.example.com")).toMatch(/^✔ www\.example\.com .*connected, primary domain/);
  expect(line("example.com")).toMatch(
    /^✔ example\.com .*connected, redirects to www\.example\.com/,
  );
  expect(line("example.net")).toContain("waiting for DNS: example.net CNAME site.b-cdn.net");
  expect(line("example.org")).toContain("not added yet");
  expect(line("stray.example.com")).toContain("on the pull zone but not in orbitpush.json");
  expect(output()).not.toContain("site.b-cdn.net ");
});

const waiting = (Value: string): Hostname => ({ Value, HasCertificate: false, ForceSSL: false });

test.each([
  ["every domain is connected", [connected("www.example.com"), connected("example.com")], true],
  ["an alias has no certificate", [connected("www.example.com"), waiting("example.com")], false],
  ["the domain has no certificate", [waiting("www.example.com"), connected("example.com")], false],
  ["an alias is not on the pull zone", [connected("www.example.com")], false],
  [
    "only a hostname outside orbitpush.json is not connected",
    [connected("www.example.com"), connected("example.com"), waiting("stray.example.com")],
    true,
  ],
])("list returns whether all domains are connected when %s", async (_, hostnames, expected) => {
  const config = await site({ domain: "www.example.com", aliases: ["example.com"] });
  fakeBunny({ hostnames });

  expect(await domains("key", config, ["list"], options)).toBe(expected);
});

test("list without domains returns true", async () => {
  const config = await site();
  fakeBunny({ hostnames: [waiting("stray.example.com")] });

  expect(await domains("key", config, ["list"], options)).toBe(true);
});

test("list without domains suggests adding one", async () => {
  const config = await site();
  fakeBunny({ hostnames: [{ Value: "site.b-cdn.net", HasCertificate: true, ForceSSL: false }] });

  await domains("key", config, ["list"], options);

  expect(output()).toContain("orbitpush domains add ");
});

test("an unknown action prints the usage", async () => {
  const config = await site();
  fakeBunny();

  await expect(domains("key", config, ["rename", "example.com"], options)).rejects.toThrow(
    /^Usage: orbitpush domains/,
  );
});

test("add of the primary domain writes the alias redirects once it gets a certificate in this run", async () => {
  const config = await site({ domain: "www.example.com", aliases: ["example.com"] });
  const { ruleWrites } = fakeBunny({
    hostnames: [waiting("www.example.com"), connected("example.com")],
    edgeRules: deployedRules({ domain: "www.example.com", aliases: [] }),
    dns: new Set(["www.example.com"]),
  });

  await domains("key", config, ["add", "www.example.com"], options);

  expect(ruleWrites().map((r) => r.Description)).toContainEqual(
    aliasRule("example\\.com", "www\\.example\\.com"),
  );
});

test("remove of an alias writes no redirect for the remaining alias while the primary domain has no certificate", async () => {
  const config = await site({ domain: "www.example.com", aliases: ["example.com", "example.net"] });
  const { writes, ruleWrites } = fakeBunny({
    hostnames: [waiting("www.example.com"), connected("example.com"), connected("example.net")],
    edgeRules: deployedRules({ domain: "www.example.com", aliases: [] }),
  });

  await domains("key", config, ["remove", "example.com"], options);

  expect(writes).toContain(`DELETE ${API}/pullzone/2/removeHostname`);
  expect(ruleWrites().filter((r) => isAliasRule(r.Description))).toEqual([]);
});

test("add leaves orbitpush.json unchanged when bunny.net refuses the hostname", async () => {
  const config = await site({ domain: "www.example.com" });
  const before = await fileText();
  const { writes } = fakeBunny({
    hostnames: [connected("www.example.com")],
    refuse: new Set([`POST ${API}/pullzone/2/addHostname`]),
  });

  await expect(domains("key", config, ["add", "example.com"], options)).rejects.toThrow();

  expect(writes).toContain(`POST ${API}/pullzone/2/addHostname`);
  expect(await fileText()).toBe(before);
});

test.each(["add", "remove"])("%s takes one hostname at a time", async (action) => {
  const config = await site({ domain: "www.example.com" });
  const { requests } = fakeBunny();

  await expect(
    domains("key", config, [action, "a.example.com", "b.example.com"], options),
  ).rejects.toThrow(`domains ${action} takes one hostname at a time`);

  expect(requests).toEqual([]);
});

test("list with an extra argument prints the usage", async () => {
  const config = await site();
  const { requests } = fakeBunny();

  await expect(domains("key", config, ["list", "extra"], options)).rejects.toThrow(
    /^Usage: orbitpush domains/,
  );

  expect(requests).toEqual([]);
});

test("Ctrl+C during the DNS wait stops it, sends no further check and removes its listener", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const config = await site();
  const { certificateChecks } = fakeBunny();
  const listeners = process.listenerCount("SIGINT");

  const done = domains("key", config, ["add", "www.example.com"], { interactive: true }).catch(
    (e: unknown) => e,
  );
  while (certificateChecks.length < 2) {
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(1000);
  }
  expect(process.listenerCount("SIGINT")).toBeGreaterThan(listeners);
  process.emit("SIGINT");
  const checksAtSignal = certificateChecks.length;
  const error = await settleWithFakeTimers(done);
  await vi.advanceTimersByTimeAsync(20 * 60 * 1000);

  expect(error).toBeInstanceOf(Cancelled);
  expect(error).toMatchObject({
    message:
      "Stopped waiting. Run `orbitpush domains add www.example.com` again once the record is set.",
  });
  expect(certificateChecks).toHaveLength(checksAtSignal);
  expect(process.listenerCount("SIGINT")).toBe(listeners);
});

test("the DNS wait removes its Ctrl+C listener when it ends", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const config = await site();
  const { certificateChecks } = fakeBunny({ dnsFromCheck: 3 });
  const listeners = process.listenerCount("SIGINT");

  const done = domains("key", config, ["add", "www.example.com"], { interactive: true });
  while (certificateChecks.length < 2) {
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(1000);
  }
  expect(process.listenerCount("SIGINT")).toBeGreaterThan(listeners);
  await settleWithFakeTimers(done);

  expect(process.listenerCount("SIGINT")).toBe(listeners);
});
