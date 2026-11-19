import { Resolver } from "node:dns/promises";

import { errorMessage } from "@/log.ts";

const PUBLIC_RESOLVERS = ["1.1.1.1", "8.8.8.8"];
const MAX_CNAME_HOPS = 8;
const NO_RECORD = new Set(["ENODATA", "ENOTFOUND"]);

export type DnsValue = { type: "CNAME"; chain: string[] } | { type: "A"; addresses: string[] };

export type DnsRecord =
  | { state: "matches"; current: DnsValue }
  | { state: "elsewhere"; current: DnsValue }
  | { state: "missing" }
  | { state: "unknown"; reason: string };

class LookupFailed extends Error {}

export async function lookUpDnsRecord(host: string, cdnHost: string): Promise<DnsRecord> {
  const resolver = new Resolver({ timeout: 3000, tries: 2 });
  resolver.setServers(PUBLIC_RESOLVERS);

  try {
    const target = normalize(cdnHost);
    const chain = await cnameChain(resolver, host);
    if (chain.length) {
      const current: DnsValue = { type: "CNAME", chain };
      return chain.includes(target)
        ? { state: "matches", current }
        : { state: "elsewhere", current };
    }

    const addresses = await addressesOf(resolver, host);
    if (!addresses.length) return { state: "missing" };

    const expected = new Set(await addressesOf(resolver, target));
    const current: DnsValue = { type: "A", addresses };

    return addresses.some((address) => expected.has(address))
      ? { state: "matches", current }
      : { state: "elsewhere", current };
  } catch (error) {
    if (error instanceof LookupFailed) return { state: "unknown", reason: error.message };
    throw error;
  }
}

async function cnameChain(resolver: Resolver, host: string) {
  const chain: string[] = [];
  let name = normalize(host);
  while (chain.length < MAX_CNAME_HOPS) {
    const [next] = await records(() => resolver.resolveCname(name));
    if (!next) break;

    name = normalize(next);
    chain.push(name);
  }

  return chain;
}

async function addressesOf(resolver: Resolver, host: string) {
  const [v4, v6] = await Promise.all([
    records(() => resolver.resolve4(host)),
    records(() => resolver.resolve6(host)),
  ]);

  return [...v4, ...v6];
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
