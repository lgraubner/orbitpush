import { readFile, writeFile } from "node:fs/promises";

import { isMissing } from "@/files.ts";
import { errorMessage } from "@/log.ts";
import { issues, z } from "@/zod.ts";

export const CONFIG_FILE = "orbitpush.json";
export const SCHEMA_URL = "https://unpkg.com/orbitpush/schema.json";
export const MISSING_CONFIG = `${CONFIG_FILE} not found. Run \`orbitpush init\` first, or \`orbitpush init --name <name> --dir <dir> --yes\` without a terminal.`;

// Storage regions: https://docs.bunny.net/storage/http
export const STORAGE_REGIONS = ["DE", "UK", "SE", "NY", "LA", "SG", "SYD", "BR", "JH"] as const;
export const GEO_ZONES = ["EU", "US", "ASIA", "SA", "AF"] as const;

export const TRAILING_SLASH = ["always", "never", "ignore"] as const;

export const Region = z.enum(STORAGE_REGIONS);
export type Region = z.infer<typeof Region>;
export const GeoZone = z.enum(GEO_ZONES);
export type GeoZone = z.infer<typeof GeoZone>;

export const Hostname = z.string().check(z.hostname());

// The shapes of [[redirects]] and [[headers]] in netlify.toml, so entries copy over as JSON
const Redirect = z.strictObject({
  from: z.string(),
  to: z.string(),
  status: z._default(z.int(), 301),
  force: z.optional(z.boolean()),
  query: z.optional(z.record(z.string(), z.string())),
  conditions: z.optional(z.record(z.string(), z.array(z.string()).check(z.minLength(1)))),
});
export type Redirect = z.infer<typeof Redirect>;

const Header = z.strictObject({
  for: z.string(),
  values: z.record(z.string(), z.string()),
});
export type Header = z.infer<typeof Header>;

const ConfigSchema = z.pipe(
  z
    .strictObject({
      $schema: z.optional(z.string()),
      name: z.string(),
      outputDir: z.string(),
      domain: z.optional(Hostname),
      aliases: z._default(z.array(Hostname), []),
      region: Region,
      replicationRegions: z.array(Region),
      geoZones: z.array(GeoZone).check(z.minLength(1)),
      trailingSlash: z.optional(z.enum(TRAILING_SLASH)),
      redirects: z._default(z.array(Redirect), []),
      headers: z._default(z.array(Header), []),
      storageZoneId: z.int(),
      pullZoneId: z.int(),
    })
    .check((ctx) => {
      const problem = aliasProblem(ctx.value);
      if (problem)
        ctx.issues.push({ code: "custom", message: problem, path: ["aliases"], input: ctx.value });
    }),
  z.transform(({ $schema: _schema, ...config }) => config),
);

// bunny.net allows 10 hostnames per pull zone by default, <name>.b-cdn.net and the domain included
const MAX_ALIASES = 8;

export function aliasProblem({ domain, aliases }: { domain?: string; aliases: string[] }) {
  if (!aliases.length) return undefined;
  if (!domain) return "aliases need a domain to redirect to";
  if (aliases.length > MAX_ALIASES) {
    return `at most ${MAX_ALIASES} aliases fit into bunny.net's 10 hostnames per pull zone, next to <name>.b-cdn.net and the domain. bunny.net support can raise the limit`;
  }

  const lower = aliases.map((alias) => alias.toLowerCase());
  const self = aliases.find((_, i) => lower[i] === domain.toLowerCase());
  if (self) return `alias ${self} is the domain itself`;

  const repeated = aliases.find((_, i) => lower.indexOf(lower[i]) !== i);
  return repeated ? `alias ${repeated} is listed twice` : undefined;
}

export function hostnameProblem(hosts: string[]) {
  const invalid = hosts.find((host) => !Hostname.safeParse(host).success);

  return invalid === undefined
    ? undefined
    : `"${invalid}" is not a hostname, such as www.example.com`;
}

export type Config = z.infer<typeof ConfigSchema>;

export async function readConfig(): Promise<Config> {
  const raw = await readFile(CONFIG_FILE, "utf8").catch((error: unknown) => {
    if (isMissing(error)) throw new Error(MISSING_CONFIG);
    throw error;
  });

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid ${CONFIG_FILE}: ${errorMessage(error)}`);
  }

  return parseConfig(json);
}

function parseConfig(json: unknown) {
  const result = ConfigSchema.safeParse(json);
  if (!result.success) {
    throw new Error(`Invalid ${CONFIG_FILE}:\n  ${issues(result.error).join("\n  ")}`);
  }

  return result.data;
}

export async function writeConfig(config: Config, { overwrite = false } = {}) {
  const json = { $schema: SCHEMA_URL, ...parseConfig(config) };
  await writeFile(CONFIG_FILE, `${JSON.stringify(json, null, 2)}\n`, {
    flag: overwrite ? "w" : "wx",
  });
}
