import { Resolver } from "node:dns/promises";

import { afterEach, expect, test, vi } from "vitest";

import { lookUpDnsRecord } from "../src/dns.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

type Zone = {
  cname?: string[];
  a?: string[];
  aaaa?: string[];
  error?: Partial<Record<"cname" | "a" | "aaaa", string>>;
};

const CDN = "site.b-cdn.net";
const CDN_ZONE: Zone = { a: ["192.0.2.1", "192.0.2.2"], aaaa: ["2001:db8::1"] };

const fail = (code: string) => Object.assign(new Error(code), { code });

function fakeDns(zones: Record<string, Zone>, missingCode = "ENODATA") {
  const servers: string[][] = [];
  const zone = (name: string) => zones[name.toLowerCase().replace(/\.$/, "")];
  const answer = (name: string, kind: "cname" | "a" | "aaaa") => {
    const entry = zone(name);
    const error = entry?.error?.[kind];
    if (error) throw fail(error);
    const values = entry?.[kind];
    if (!values?.length) throw fail(entry ? "ENODATA" : missingCode);
    return values;
  };

  vi.spyOn(Resolver.prototype, "setServers").mockImplementation((list) => {
    servers.push([...list]);
  });
  const resolveCname = vi
    .spyOn(Resolver.prototype, "resolveCname")
    .mockImplementation(async (name: string) => answer(name, "cname"));
  vi.spyOn(Resolver.prototype, "resolve4").mockImplementation((async (name: string) =>
    answer(name, "a")) as Resolver["resolve4"]);
  vi.spyOn(Resolver.prototype, "resolve6").mockImplementation((async (name: string) =>
    answer(name, "aaaa")) as Resolver["resolve6"]);

  return { servers, resolveCname };
}

test("a CNAME to this pull zone matches and lists the chain without the host", async () => {
  fakeDns({ "www.example.com": { cname: ["site.b-cdn.net"] }, [CDN]: CDN_ZONE });

  expect(await lookUpDnsRecord("www.example.com", CDN)).toEqual({
    state: "matches",
    current: { type: "CNAME", chain: ["site.b-cdn.net"] },
  });
});

test("a CNAME matches case-insensitively and with a trailing dot, and the chain is normalized", async () => {
  fakeDns({ "www.example.com": { cname: ["Site.B-CDN.net."] }, [CDN]: CDN_ZONE });

  expect(await lookUpDnsRecord("www.example.com", "SITE.b-cdn.net.")).toEqual({
    state: "matches",
    current: { type: "CNAME", chain: ["site.b-cdn.net"] },
  });
});

test("a CNAME chain that reaches this pull zone in a later hop matches", async () => {
  fakeDns({
    "www.example.com": { cname: ["proxy.example.net."] },
    "proxy.example.net": { cname: ["site.b-cdn.net"] },
    [CDN]: CDN_ZONE,
  });

  expect(await lookUpDnsRecord("www.example.com", CDN)).toEqual({
    state: "matches",
    current: { type: "CNAME", chain: ["proxy.example.net", "site.b-cdn.net"] },
  });
});

test("a CNAME to another pull zone is elsewhere even though it shares this pull zone's addresses", async () => {
  fakeDns({
    "www.example.com": { cname: ["other-site.b-cdn.net"] },
    "other-site.b-cdn.net": CDN_ZONE,
    [CDN]: CDN_ZONE,
  });

  expect(await lookUpDnsRecord("www.example.com", CDN)).toEqual({
    state: "elsewhere",
    current: { type: "CNAME", chain: ["other-site.b-cdn.net"] },
  });
});

test("a CNAME loop ends as elsewhere instead of hanging", async () => {
  const { resolveCname } = fakeDns({
    "www.example.com": { cname: ["a.example.net"] },
    "a.example.net": { cname: ["b.example.net"] },
    "b.example.net": { cname: ["a.example.net"] },
    [CDN]: CDN_ZONE,
  });

  const record = await lookUpDnsRecord("www.example.com", CDN);

  expect(record.state).toBe("elsewhere");
  expect(resolveCname.mock.calls.length).toBeLessThanOrEqual(9);
});

const chainTo = (hops: number): Record<string, Zone> => {
  const names = [
    "www.example.com",
    ...Array.from({ length: hops - 1 }, (_, i) => `h${i}.example.net`),
    CDN,
  ];
  return {
    ...Object.fromEntries(names.slice(0, -1).map((name, i) => [name, { cname: [names[i + 1]] }])),
    [CDN]: CDN_ZONE,
  };
};

test("a CNAME chain reaching this pull zone at the 8th hop matches", async () => {
  fakeDns(chainTo(8));

  const record = await lookUpDnsRecord("www.example.com", CDN);

  expect(record.state).toBe("matches");
  expect(record).toMatchObject({ current: { type: "CNAME" } });
  if (record.state === "matches" && record.current.type === "CNAME") {
    expect(record.current.chain).toHaveLength(8);
    expect(record.current.chain.at(-1)).toBe(CDN);
  }
});

test("a CNAME chain longer than 8 hops stops following and is not a match", async () => {
  const { resolveCname } = fakeDns(chainTo(30));

  const record = await lookUpDnsRecord("www.example.com", CDN);

  expect(record.state).toBe("elsewhere");
  expect(resolveCname.mock.calls.length).toBeLessThanOrEqual(9);
});

test.each(["ENODATA", "ENOTFOUND"])(
  "without a CNAME (%s), an A address shared with this pull zone matches",
  async (code) => {
    fakeDns({ "example.com": { a: ["192.0.2.2"] }, [CDN]: CDN_ZONE }, code);
    vi.mocked(Resolver.prototype.resolveCname).mockImplementation(async (name: string) => {
      throw fail(name === "example.com" ? code : "ENODATA");
    });

    expect(await lookUpDnsRecord("example.com", CDN)).toEqual({
      state: "matches",
      current: { type: "A", addresses: ["192.0.2.2"] },
    });
  },
);

test("without a CNAME, an AAAA address shared with this pull zone matches", async () => {
  fakeDns({ "example.com": { a: ["203.0.113.5"], aaaa: ["2001:db8::1"] }, [CDN]: CDN_ZONE });

  const record = await lookUpDnsRecord("example.com", CDN);

  expect(record.state).toBe("matches");
  expect(record).toMatchObject({ current: { type: "A" } });
  if (record.state === "matches" && record.current.type === "A") {
    expect([...record.current.addresses].sort()).toEqual(["2001:db8::1", "203.0.113.5"]);
  }
});

test("without a CNAME, addresses that this pull zone does not have are elsewhere", async () => {
  fakeDns({ "example.com": { a: ["203.0.113.5"] }, [CDN]: CDN_ZONE });

  expect(await lookUpDnsRecord("example.com", CDN)).toEqual({
    state: "elsewhere",
    current: { type: "A", addresses: ["203.0.113.5"] },
  });
});

test.each(["ENODATA", "ENOTFOUND"])(
  "a host with neither CNAME nor addresses (%s) is missing",
  async (code) => {
    fakeDns({ [CDN]: CDN_ZONE }, code);

    expect(await lookUpDnsRecord("www.example.com", CDN)).toEqual({ state: "missing" });
  },
);

test.each([
  ["the host's CNAME", { "www.example.com": { error: { cname: "ETIMEOUT" } } }, "ETIMEOUT"],
  [
    "a later hop's CNAME",
    {
      "www.example.com": { cname: ["proxy.example.net"] },
      "proxy.example.net": { error: { cname: "ESERVFAIL" } },
    },
    "ESERVFAIL",
  ],
  ["the host's A record", { "example.com": { error: { a: "ESERVFAIL" } } }, "ESERVFAIL"],
  [
    "the host's AAAA record",
    { "example.com": { a: ["192.0.2.1"], error: { aaaa: "ETIMEOUT" } } },
    "ETIMEOUT",
  ],
  [
    "this pull zone's addresses",
    { "example.com": { a: ["192.0.2.1"] }, [CDN]: { error: { a: "ECONNREFUSED" } } },
    "ECONNREFUSED",
  ],
])(
  "a failed lookup of %s is unknown with its code",
  async (_, zones: Record<string, Zone>, code) => {
    fakeDns({ [CDN]: CDN_ZONE, ...zones });
    const host = Object.keys(zones).find((name) => name !== CDN) ?? "";

    expect(await lookUpDnsRecord(host, CDN)).toEqual({ state: "unknown", reason: code });
  },
);

test("the lookup asks the public resolvers 1.1.1.1 and 8.8.8.8", async () => {
  const { servers } = fakeDns({ "www.example.com": { cname: [CDN] }, [CDN]: CDN_ZONE });

  await lookUpDnsRecord("www.example.com", CDN);

  expect(servers).toEqual([["1.1.1.1", "8.8.8.8"]]);
});
