import { readFile, writeFile } from "node:fs/promises";

import en from "zod/v4/locales/en.js";
import * as z from "zod/mini";

import { isMissing } from "./files.ts";
import { errorMessage } from "./log.ts";

// zod/mini ships without error messages, so its issues would all read "Invalid input"
z.config(en());

export const CONFIG_FILE = "orbitpush.json";
export const SCHEMA_URL = "https://unpkg.com/orbitpush/schema.json";

// Storage regions: https://docs.bunny.net/storage/http
export const STORAGE_REGIONS = ["DE", "UK", "SE", "NY", "LA", "SG", "SYD", "BR", "JH"] as const;
export const GEO_ZONES = ["EU", "US", "ASIA", "SA", "AF"] as const;

export const Region = z.enum(STORAGE_REGIONS);
export type Region = z.infer<typeof Region>;
export type GeoZone = (typeof GEO_ZONES)[number];

const ConfigSchema = z.object({
  name: z.string(),
  outputDir: z.string(),
  spa: z.boolean(),
  domains: z.array(z.string()),
  region: Region,
  replicationRegions: z.array(Region),
  geoZones: z.array(z.enum(GEO_ZONES)),
  storageZoneId: z.int(),
  pullZoneId: z.int(),
});

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
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
    throw new Error(`Invalid ${CONFIG_FILE}:\n  ${problems.join("\n  ")}`);
  }

  return result.data;
}

export async function writeConfig(config: Config) {
  await writeFile(CONFIG_FILE, `${JSON.stringify({ $schema: SCHEMA_URL, ...config }, null, 2)}\n`);
}
