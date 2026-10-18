import { existsSync } from "node:fs";
import { basename } from "node:path";

import { checkbox, input, password, select } from "@inquirer/prompts";

import {
  api,
  API_KEY_URL,
  apiJson,
  apiKeyFromEnv,
  CreatedZone,
  envApiKey,
  geoZoneFlags,
} from "./bunny.ts";
import {
  aliasProblem,
  type Config,
  CONFIG_FILE,
  GEO_ZONES,
  type GeoZone,
  Region,
  STORAGE_REGIONS,
  writeConfig,
} from "./config.ts";
import { ensureDomains } from "./deploy.ts";
import { errorMessage, log } from "./log.ts";

export type InitFlags = {
  name?: string;
  dir?: string;
  domain?: string;
  alias?: string | string[];
  region?: string;
  yes?: boolean;
};

export async function init(flags: InitFlags, interactive: boolean) {
  if (existsSync(CONFIG_FILE)) throw new Error(`${CONFIG_FILE} already exists.`);

  const prompt = interactive && !flags.yes;
  const ask = async <T>(flag: T | undefined, fallback: T, question: () => Promise<T>) =>
    flag ?? (prompt ? question() : fallback);

  const apiKey = envApiKey() ?? (prompt ? await promptApiKey() : apiKeyFromEnv());

  const defaultName = basename(process.cwd())
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-");
  const validName = (v: string) => /^[a-z0-9-]+$/i.test(v) || "Only letters, numbers and dashes";
  const name = await ask(flags.name, defaultName, () =>
    input({
      message: "Project name (used for storage zone and pull zone)",
      default: defaultName,
      validate: validName,
    }),
  );
  if (validName(name) !== true) {
    throw new Error(`Invalid name "${name}": only letters, numbers and dashes`);
  }

  const defaultDir = ["dist", "build", "out", "public"].find((dir) => existsSync(dir)) ?? "dist";
  const outputDir = await ask(flags.dir, defaultDir, () =>
    input({ message: "Build output directory", default: defaultDir }),
  );
  const domain =
    (await ask(flags.domain, "", () => input({ message: "Custom domain (optional)" }))).trim() ||
    undefined;
  const aliasFlag = flags.alias === undefined ? undefined : [flags.alias].flat().join(",");
  const aliases = splitList(
    await ask(aliasFlag, "", () =>
      domain
        ? input({
            message: `Aliases that redirect to ${domain}, comma separated (optional)`,
            validate: (v) => aliasProblem({ domain, aliases: splitList(v) }) ?? true,
          })
        : Promise.resolve(""),
    ),
  );
  const problem = aliasProblem({ domain, aliases });
  if (problem) throw new Error(`Invalid --alias: ${problem}`);

  const regionAnswer = await ask(flags.region, "DE", () =>
    select({ message: "Main storage region", choices: STORAGE_REGIONS, default: "DE" }),
  );
  const region = Region.safeParse(regionAnswer.toUpperCase()).data;
  if (!region) throw new Error(`Region must be one of ${STORAGE_REGIONS.join(", ")}`);

  const replicationRegions: Region[] = prompt
    ? await checkbox({
        message: "Storage replication regions (cannot be removed later)",
        choices: STORAGE_REGIONS.filter((r) => r !== region),
      })
    : [];
  const geoZones: GeoZone[] = prompt
    ? await checkbox({
        message: "CDN delivery regions",
        choices: GEO_ZONES.map((value) => ({ value, checked: value === "EU" || value === "US" })),
        validate: (v) => v.length > 0 || "Select at least one",
      })
    : ["EU", "US"];

  log.step(`Creating storage zone ${name}`);
  const storageZone = await apiJson(apiKey, {
    schema: CreatedZone,
    method: "POST",
    path: "/storagezone",
    body: {
      Name: name,
      Region: region,
      ReplicationRegions: replicationRegions,
      ZoneTier: 0,
    },
  });

  let pullZone: CreatedZone | undefined;
  let config: Config;
  try {
    log.step(`Creating pull zone ${name}`);
    pullZone = await apiJson(apiKey, {
      schema: CreatedZone,
      method: "POST",
      path: "/pullzone",
      body: {
        Name: name,
        OriginType: 2,
        StorageZoneId: storageZone.Id,
        ...geoZoneFlags(geoZones),
      },
    });

    config = {
      name,
      outputDir,
      domain,
      aliases,
      region,
      replicationRegions,
      geoZones,
      storageZoneId: storageZone.Id,
      pullZoneId: pullZone.Id,
    };
    await writeConfig(config);
  } catch (error) {
    await deleteNewZones(apiKey, { name, storageZone, pullZone });
    throw error;
  }

  log.success(`Created ${CONFIG_FILE}`);

  const cdnHost = await ensureDomains(apiKey, config);
  log.success(`Ready: https://${cdnHost}`);
  if (!envApiKey()) log.detail("Set BUNNY_API_KEY in your environment before deploying.");
  log.detail("Next: build your site, then run `npx orbitpush deploy`");
}

function splitList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function promptApiKey() {
  log.step(`Find your API key at ${API_KEY_URL}`);

  return password({ message: "Bunny API key", mask: true, validate: (v) => !!v.trim() });
}

async function deleteNewZones(
  apiKey: string,
  {
    name,
    storageZone,
    pullZone,
  }: { name: string; storageZone: CreatedZone; pullZone: CreatedZone | undefined },
) {
  const remove = (path: string, label: string) =>
    api(apiKey, { method: "DELETE", path }).catch((error: unknown) =>
      log.warn(
        `Could not delete ${label}. Delete it in the bunny.net dashboard. ${errorMessage(error)}`,
      ),
    );

  if (pullZone) await remove(`/pullzone/${pullZone.Id}`, `pull zone ${name} (${pullZone.Id})`);
  await remove(`/storagezone/${storageZone.Id}`, `storage zone ${name} (${storageZone.Id})`);
}
