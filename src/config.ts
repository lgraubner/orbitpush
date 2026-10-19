import { readFile, writeFile } from "node:fs/promises";

import { isMissing } from "./files.ts";
import { errorMessage } from "./log.ts";
import { issues, z } from "./zod.ts";

export const CONFIG_FILE = "orbitpush.json";
export const SCHEMA_URL = "https://unpkg.com/orbitpush/schema.json";

// Storage regions: https://docs.bunny.net/storage/http
export const STORAGE_REGIONS = ["DE", "UK", "SE", "NY", "LA", "SG", "SYD", "BR", "JH"] as const;
export const GEO_ZONES = ["EU", "US", "ASIA", "SA", "AF"] as const;

export const TRAILING_SLASH = ["always", "never", "ignore"] as const;

export const Region = z.enum(STORAGE_REGIONS);
export type Region = z.infer<typeof Region>;
export const GeoZone = z.enum(GEO_ZONES);
export type GeoZone = z.infer<typeof GeoZone>;

export const Hostname = z.string().check(z.hostname());

const ConfigSchema = z
  .object({
    name: z.string(),
    outputDir: z.string(),
    domain: z.optional(Hostname),
    aliases: z._default(z.array(Hostname), []),
    region: Region,
    replicationRegions: z.array(Region),
    geoZones: z.array(GeoZone).check(z.minLength(1)),
    trailingSlash: z.optional(z.enum(TRAILING_SLASH)),
    storageZoneId: z.int(),
    pullZoneId: z.int(),
  })
  .check((ctx) => {
    const problem = aliasProblem(ctx.value);
    if (problem)
      ctx.issues.push({ code: "custom", message: problem, path: ["aliases"], input: ctx.value });
  });

// bunny.net allows 10 hostnames per pull zone by default, <name>.b-cdn.net and the domain included
const MAX_ALIASES = 8;

export function aliasProblem({ domain, aliases }: { domain?: string; aliases: string[] }) {
  if (!aliases.length) return undefined;
  if (!domain) return "aliases need a domain to redirect to";
  if (aliases.length > MAX_ALIASES) {
    return `at most ${MAX_ALIASES} aliases fit into bunny.net's 10 hostnames per pull zone, next to <name>.b-cdn.net and the domain. bunny.net support can raise the limit`;
  }

  const repeated = aliases.find((alias) => alias.toLowerCase() === domain.toLowerCase());
  return repeated ? `alias ${repeated} is the domain itself` : undefined;
}

export type Config = z.infer<typeof ConfigSchema>;

export async function readConfig(): Promise<Config> {
  const raw = await readFile(CONFIG_FILE, "utf8").catch((error: unknown) => {
    if (isMissing(error))
      throw new Error(`${CONFIG_FILE} not found. Run \`orbitpush init\` first.`);
    throw error;
  });

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid ${CONFIG_FILE}: ${errorMessage(error)}`);
  }

  const result = ConfigSchema.safeParse(json);
  if (!result.success) {
    throw new Error(`Invalid ${CONFIG_FILE}:\n  ${issues(result.error).join("\n  ")}`);
  }

  return result.data;
}

export async function writeConfig(config: Config) {
  await writeFile(CONFIG_FILE, `${JSON.stringify({ $schema: SCHEMA_URL, ...config }, null, 2)}\n`, {
    flag: "wx",
  });
}
