import { Resolver } from "node:dns/promises";

import { errorMessage } from "@/log.ts";

const PUBLIC_RESOLVERS = ["1.1.1.1", "8.8.8.8"];
const MAX_CNAME_HOPS = 8;
const NO_RECORD = new Set(["ENODATA", "ENOTFOUND"]);
const PULL_ZONE_SUFFIX = ".b-cdn.net";

export type DnsValue = { chain: string[]; addresses: string[] };

export type DnsRecord =
  | { state: "matches"; by: "cname" | "address"; current: DnsValue }
  | { state: "other-pull-zone"; current: DnsValue }
  | { state: "elsewhere"; current: DnsValue }
  | { state: "missing" }
  | { state: "unknown"; reason: string };

class LookupFailed extends Error {}

export async function lookUpDnsRecord(host: string, cdnHost: string): Promise<DnsRecord> {
  const resolver = new Resolver({ timeout: 2000, tries: 1 });
  resolver.setServers(PUBLIC_RESOLVERS);

  try {
    const target = normalize(cdnHost);
    const chain = await cnameChain(resolver, host, target);
    if (chain.includes(target))
      return { state: "matches", by: "cname", current: { chain, addresses: [] } };
    if (chain.some((name) => name.endsWith(PULL_ZONE_SUFFIX))) {
      return { state: "other-pull-zone", current: { chain, addresses: [] } };
    }

    const expectedLookup = addressesOf(resolver, target);
    expectedLookup.catch(() => undefined);
    const addresses = await addressesOf(resolver, chain.at(-1) ?? host);
    if (!chain.length && !addresses.length) return { state: "missing" };

    const current = { chain, addresses };
    const expected = new Set(await expectedLookup);

    return addresses.some((address) => expected.has(address))
      ? { state: "matches", by: "address", current }
      : { state: "elsewhere", current };
  } catch (error) {
    if (error instanceof LookupFailed) return { state: "unknown", reason: error.message };
    throw error;
  }
}

async function cnameChain(resolver: Resolver, host: string, target: string) {
  const chain: string[] = [];
  let name = normalize(host);
  while (chain.length < MAX_CNAME_HOPS && name !== target) {
    const [next] = await records(() => resolver.resolveCname(name));
    if (!next) break;

    name = normalize(next);
    chain.push(name);
  }

  return chain;
}

async function addressesOf(resolver: Resolver, host: string) {
  const results = await Promise.allSettled([
    records(() => resolver.resolve4(host)),
    records(() => resolver.resolve6(host)),
  ]);
  const found = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  const failure = results.find((result) => result.status === "rejected");
  if (failure && !found.length) throw failure.reason;

  return found.sort();
}

async function records(lookup: () => Promise<string[]>) {
  try {
    return await lookup();
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
    if (code && NO_RECORD.has(code)) return [];

    throw new LookupFailed(code ?? errorMessage(error));
  }
}

function normalize(host: string) {
  return host.toLowerCase().replace(/\.$/, "");
}
