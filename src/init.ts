import { existsSync } from "node:fs";
import { basename } from "node:path";

import { checkbox, confirm, input, password, select } from "@inquirer/prompts";

import {
  api,
  API_KEY_URL,
  apiJson,
  apiKeyFromEnv,
  CreatedZone,
  ensureDomains,
  envApiKey,
  geoZoneFlags,
  getPullZone,
} from "./bunny.ts";
import {
  aliasProblem,
  type Config,
  CONFIG_FILE,
  GEO_ZONES,
  GeoZone,
  hostnameProblem,
  MISSING_CONFIG,
  Region,
  STORAGE_REGIONS,
  writeConfig,
} from "./config.ts";
import { errorMessage, log } from "./log.ts";

export type InitFlags = {
  name?: string;
  dir?: string;
  domain?: string;
  alias?: string | string[];
  region?: string;
  "replication-region"?: string | string[];
  "delivery-region"?: string | string[];
  yes?: boolean;
};

export async function setUpForDeploy() {
  const setUp = await confirm({
    message: `No ${CONFIG_FILE} here. Set up a new site on bunny.net now?`,
    default: true,
  });
  if (!setUp) throw new Error(MISSING_CONFIG);

  return init({}, true, { deploying: true });
}

export async function init(
  flags: InitFlags,
  interactive: boolean,
  { deploying = false }: { deploying?: boolean } = {},
) {
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
    input({
      message: "Build output directory",
      default: defaultDir,
      validate: (v) =>
        !deploying || existsSync(v) || `${v} not found. Build the site, then run deploy again`,
    }),
  );
  const domain =
    (
      await ask(flags.domain, "", () =>
        input({
          message: "Custom domain (optional)",
          validate: (v) => hostnameProblem(v.trim() ? [v.trim()] : []) ?? true,
        }),
      )
    ).trim() || undefined;
  const domainProblem = hostnameProblem(domain ? [domain] : []);
  if (domainProblem) throw new Error(`Invalid --domain: ${domainProblem}`);

  const aliasFlag = flags.alias === undefined ? undefined : [flags.alias].flat().join(",");
  const aliases = splitList(
    await ask(aliasFlag, "", () =>
      domain
        ? input({
            message: `Aliases that redirect to ${domain}, comma separated (optional)`,
            validate: (v) =>
              hostnameProblem(splitList(v)) ??
              aliasProblem({ domain, aliases: splitList(v) }) ??
              true,
          })
        : Promise.resolve(""),
    ),
  );
  const problem = hostnameProblem(aliases) ?? aliasProblem({ domain, aliases });
  if (problem) throw new Error(`Invalid --alias: ${problem}`);

  const regionAnswer = await ask(flags.region, "DE", () =>
    select({ message: "Main storage region", choices: STORAGE_REGIONS, default: "DE" }),
  );
  const region = Region.safeParse(regionAnswer.toUpperCase()).data;
  if (!region) throw new Error(`Region must be one of ${STORAGE_REGIONS.join(", ")}`);

  const replicationAnswer: string[] = await ask(listFlag(flags["replication-region"]), [], () =>
    checkbox({
      message: "Storage replication regions (cannot be removed later)",
      choices: STORAGE_REGIONS.filter((r) => r !== region),
    }),
  );
  const replicationRegions = parseList(Region, replicationAnswer, "--replication-region");
  if (replicationRegions.includes(region)) {
    throw new Error(`Invalid --replication-region: ${region} is the main region`);
  }

  const deliveryAnswer: string[] = await ask(listFlag(flags["delivery-region"]), ["EU", "US"], () =>
    checkbox({
      message: "CDN delivery regions",
      choices: GEO_ZONES.map((value) => ({ value, checked: value === "EU" || value === "US" })),
      validate: (v) => v.length > 0 || "Select at least one",
    }),
  );
  const geoZones = parseList(GeoZone, deliveryAnswer, "--delivery-region");
  if (!geoZones.length) {
    throw new Error(`Invalid --delivery-region: name at least one of ${GEO_ZONES.join(", ")}`);
  }

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
      redirects: [],
      headers: [],
      storageZoneId: storageZone.Id,
      pullZoneId: pullZone.Id,
    };
    await writeConfig(config);
  } catch (error) {
    await deleteNewZones(apiKey, { name, storageZone, pullZone });
    throw error;
  }

  log.success(`Created ${CONFIG_FILE}`);

  const { url } = await ensureDomains(apiKey, config, await getPullZone(apiKey, config.pullZoneId));
  log.success(`Ready: ${url}`);
  if (!envApiKey()) log.detail("Set BUNNY_API_KEY in your environment before deploying.");
  if (!deploying) log.detail("Next: build your site, then run `npx orbitpush deploy`");

  return { apiKey, config };
}

function listFlag(flag: string | string[] | undefined) {
  return flag === undefined ? undefined : splitList([flag].flat().join(","));
}

function parseList<T extends string>(
  schema: { safeParse(value: unknown): { data?: T }; options: readonly T[] },
  values: string[],
  flag: string,
) {
  return values.map((value) => {
    const parsed = schema.safeParse(value.toUpperCase()).data;
    if (parsed === undefined) {
      throw new Error(`Invalid ${flag}: ${value} is not one of ${schema.options.join(", ")}`);
    }

    return parsed;
  });
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
