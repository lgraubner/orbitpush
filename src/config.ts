import { readFile, writeFile } from "node:fs/promises";

export const CONFIG_FILE = "orbitpush.json";
export const SCHEMA_URL = "https://unpkg.com/orbitpush/schema.json";
// Storage regions: https://docs.bunny.net/storage/http
export const STORAGE_REGIONS = ["DE", "UK", "SE", "NY", "LA", "SG", "SYD", "BR", "JH"];
export const GEO_ZONES = ["EU", "US", "ASIA", "SA", "AF"];

export type Config = {
  name: string;
  outputDir: string;
  spa: boolean;
  domains: string[];
  region: string;
  replicationRegions: string[];
  geoZones: string[];
  storageZoneId: number;
  pullZoneId: number;
};

export async function readConfig(): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(CONFIG_FILE, "utf8");
  } catch {
    throw new Error(`${CONFIG_FILE} not found. Run \`orbitpush init\` first.`);
  }
  const config = JSON.parse(raw) as Config;
  const problems = [
    typeof config.name !== "string" && "name must be a string",
    typeof config.outputDir !== "string" && "outputDir must be a string",
    typeof config.spa !== "boolean" && "spa must be true or false",
    !isList(config.domains) && "domains must be a list of hostnames",
    !STORAGE_REGIONS.includes(config.region) &&
      `region must be one of ${STORAGE_REGIONS.join(", ")}`,
    !isList(config.replicationRegions, STORAGE_REGIONS) &&
      `replicationRegions must only contain ${STORAGE_REGIONS.join(", ")}`,
    !isList(config.geoZones, GEO_ZONES) && `geoZones must only contain ${GEO_ZONES.join(", ")}`,
    !Number.isInteger(config.storageZoneId) && "storageZoneId must be a number",
    !Number.isInteger(config.pullZoneId) && "pullZoneId must be a number",
  ].filter(Boolean);
  if (problems.length) throw new Error(`Invalid ${CONFIG_FILE}:\n  ${problems.join("\n  ")}`);
  return config;
}

export async function writeConfig(config: Config) {
  await writeFile(CONFIG_FILE, `${JSON.stringify({ $schema: SCHEMA_URL, ...config }, null, 2)}\n`);
}

function isList(value: unknown, allowed?: string[]) {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && (!allowed || allowed.includes(item)))
  );
}
