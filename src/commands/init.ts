import { existsSync } from "node:fs";
import { basename } from "node:path";

import { checkbox, confirm, input, password, select } from "@inquirer/prompts";

import {
  api,
  API_KEY_URL,
  apiJson,
  apiKeyFromEnv,
  CreatedZone,
  envApiKey,
  geoZoneFlags,
  isNameAvailable,
} from "@/bunny.ts";
import {
  type Config,
  CONFIG_FILE,
  GEO_ZONES,
  GeoZone,
  MISSING_CONFIG,
  Region,
  STORAGE_REGIONS,
  writeConfig,
} from "@/config.ts";
import { errorMessage, log } from "@/log.ts";

export type InitFlags = {
  name?: string;
  dir?: string;
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
  const ask: Ask = async (flag, fallback, question) => flag ?? (prompt ? question() : fallback);

  const defaultName = basename(process.cwd())
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-");
  const defaultDir = ["dist", "build", "out", "public"].find((dir) => existsSync(dir)) ?? "dist";
  if (!interactive && !flags.yes && (!flags.name || !flags.dir)) {
    throw new Error(
      `Without a terminal, init needs --name and --dir, or --yes for the defaults (name ${defaultName}, dir ${defaultDir}).`,
    );
  }

  const apiKey = envApiKey() ?? (prompt ? await promptApiKey() : apiKeyFromEnv());

  const name = await chooseName(apiKey, flags.name, defaultName, prompt);

  const outputDir = await ask(flags.dir, defaultDir, () =>
    input({
      message: "Build output directory",
      default: defaultDir,
      validate: (v) =>
        !deploying || existsSync(v) || `${v} not found. Build the site, then run deploy again`,
    }),
  );
  const { region, replicationRegions, geoZones } = await askRegions(flags, ask);

  if (!(await isNameAvailable(apiKey, name))) throw nameTaken(name);

  log.step(`Creating storage zone ${name}`);
  const storageZone = await apiJson(apiKey, {
    schema: CreatedZone,
    action: `create the storage zone ${name}`,
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
      action: `create the pull zone ${name}`,
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
      aliases: [],
      region,
      replicationRegions,
      geoZones,
      redirects: [],
      headers: [],
      pullZoneId: pullZone.Id,
    };
    await writeConfig(config);
  } catch (error) {
    await deleteNewZones(apiKey, { name, storageZone, pullZone });
    throw error;
  }

  log.success(`Created ${CONFIG_FILE}`);

  log.success(`Ready: https://${name}.b-cdn.net`);
  if (!envApiKey()) log.detail("Set BUNNY_API_KEY in your environment before deploying.");
  if (!deploying) {
    log.detail("Next:");
    log.detail("  1. Build your site, then run `npx orbitpush deploy`");
    log.detail("  2. Use your own domain: `npx orbitpush domains add www.example.com`");
  }

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

type Ask = <T>(flag: T | undefined, fallback: T, question: () => Promise<T>) => Promise<T>;

async function askRegions(flags: InitFlags, ask: Ask) {
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

  return { region, replicationRegions, geoZones };
}

const validName = (v: string) => /^[a-z0-9-]+$/i.test(v) || "Only letters, numbers and dashes";

async function chooseName(
  apiKey: string,
  flag: string | undefined,
  defaultName: string,
  prompt: boolean,
) {
  if (prompt && flag === undefined) {
    return promptFreeName(apiKey, defaultName);
  }

  const name = flag ?? defaultName;
  if (validName(name) !== true) {
    throw new Error(`Invalid name "${name}": only letters, numbers and dashes`);
  }

  if (prompt && !(await isNameAvailable(apiKey, name))) throw nameTaken(name);

  return name;
}

const nameTaken = (name: string) =>
  new Error(`The name "${name}" is already taken on bunny.net. Choose another with --name.`);

async function promptFreeName(apiKey: string, defaultName: string) {
  let fallback: string | undefined = defaultName;
  for (;;) {
    const name = await input({
      message: "Project name (used for storage zone and pull zone)",
      default: fallback,
      validate: validName,
    });
    if (await isNameAvailable(apiKey, name)) return name;

    log.warn(`"${name}" is already taken on bunny.net`);
    if (name.toLowerCase() === fallback?.toLowerCase()) fallback = undefined;
  }
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
    api(apiKey, { action: `delete the ${label}`, method: "DELETE", path }).catch(
      (error: unknown) => {
        log.warn(errorMessage(error));
        log.detail(`Delete the ${label} in the bunny.net dashboard.`);
      },
    );

  if (pullZone) await remove(`/pullzone/${pullZone.Id}`, `pull zone ${name} (${pullZone.Id})`);
  await remove(`/storagezone/${storageZone.Id}`, `storage zone ${name} (${storageZone.Id})`);
}
