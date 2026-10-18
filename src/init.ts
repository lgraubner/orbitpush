import { existsSync } from "node:fs";
import { basename } from "node:path";

import { checkbox, confirm, input, password, select } from "@inquirer/prompts";

import { api, API_KEY_URL, type PullZone, type StorageZone } from "./bunny.ts";
import { type Config, CONFIG_FILE, GEO_ZONES, STORAGE_REGIONS, writeConfig } from "./config.ts";
import { ensureDomains } from "./deploy.ts";
import { log } from "./log.ts";

export type InitFlags = {
  name?: string;
  dir?: string;
  spa?: boolean;
  domain?: string | string[];
  region?: string;
  yes?: boolean;
};

export async function init(flags: InitFlags, interactive: boolean) {
  if (existsSync(CONFIG_FILE)) throw new Error(`${CONFIG_FILE} already exists.`);
  const prompt = interactive && !flags.yes;
  const ask = async <T>(flag: T | undefined, fallback: T, question: () => Promise<T>) =>
    flag ?? (prompt ? question() : fallback);

  let apiKey = process.env.BUNNY_API_KEY?.trim();
  if (!apiKey) {
    if (!prompt) throw new Error(`BUNNY_API_KEY is not set. Create an API key at ${API_KEY_URL}`);
    log.step(`Find your API key at ${API_KEY_URL}`);
    apiKey = await password({ message: "Bunny API key", mask: true, validate: (v) => !!v.trim() });
  }

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
  if (validName(name) !== true)
    throw new Error(`Invalid name "${name}": only letters, numbers and dashes`);

  const defaultDir = ["dist", "build", "out", "public"].find((dir) => existsSync(dir)) ?? "dist";
  const outputDir = await ask(flags.dir, defaultDir, () =>
    input({ message: "Build output directory", default: defaultDir }),
  );
  const spa = await ask(flags.spa, false, () =>
    confirm({ message: "Single-page app (serve index.html for unknown paths)?", default: false }),
  );
  const domainFlag = flags.domain === undefined ? undefined : [flags.domain].flat().join(",");
  const domains = (
    await ask(domainFlag, "", () =>
      input({ message: "Custom domains, comma separated (optional)" }),
    )
  )
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  const region = (
    await ask(flags.region, "DE", () =>
      select({ message: "Main storage region", choices: STORAGE_REGIONS, default: "DE" }),
    )
  ).toUpperCase();
  if (!STORAGE_REGIONS.includes(region))
    throw new Error(`Region must be one of ${STORAGE_REGIONS.join(", ")}`);
  const replicationRegions = prompt
    ? await checkbox({
        message: "Storage replication regions (cannot be removed later)",
        choices: STORAGE_REGIONS.filter((r) => r !== region),
      })
    : [];
  const geoZones = prompt
    ? await checkbox({
        message: "CDN delivery regions",
        choices: GEO_ZONES.map((value) => ({ value, checked: value === "EU" || value === "US" })),
        validate: (v) => v.length > 0 || "Select at least one",
      })
    : ["EU", "US"];

  log.step(`Creating storage zone ${name}`);
  const storageZone = await api<StorageZone>(apiKey, "POST", "/storagezone", {
    Name: name,
    Region: region,
    ReplicationRegions: replicationRegions,
    ZoneTier: 0,
  });

  // Until orbitpush.json exists, nothing points at the new zones and their names stay taken, so
  // any failure before then deletes them again. Later steps (domains) are reconciled by deploy.
  let pullZone: PullZone | undefined;
  let config: Config;
  try {
    log.step(`Creating pull zone ${name}`);
    pullZone = await api<PullZone>(apiKey, "POST", "/pullzone", {
      Name: name,
      OriginType: 2,
      StorageZoneId: storageZone.Id,
      ...Object.fromEntries(
        GEO_ZONES.map((zone) => [`EnableGeoZone${zone}`, geoZones.includes(zone)]),
      ),
    });

    config = {
      name,
      outputDir,
      spa,
      domains,
      region,
      replicationRegions,
      geoZones,
      storageZoneId: storageZone.Id,
      pullZoneId: pullZone.Id,
    };
    await writeConfig(config);
  } catch (error) {
    const remove = (path: string, label: string) =>
      api(apiKey, "DELETE", path).catch(() =>
        log.warn(`Could not delete ${label}. Delete it in the bunny.net dashboard.`),
      );
    if (pullZone) await remove(`/pullzone/${pullZone.Id}`, `pull zone ${name} (${pullZone.Id})`);
    await remove(`/storagezone/${storageZone.Id}`, `storage zone ${name} (${storageZone.Id})`);
    throw error;
  }

  log.success(`Created ${CONFIG_FILE}`);

  const cdnHost = await ensureDomains(apiKey, config);
  log.success(`Ready: https://${cdnHost}`);
  if (!process.env.BUNNY_API_KEY)
    log.detail("Set BUNNY_API_KEY in your environment before deploying.");
  log.detail("Next: build your site, then run `npx orbitpush deploy`");
}
