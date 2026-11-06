import { rm } from "node:fs/promises";

import { input } from "@inquirer/prompts";

import { api, ApiError, getPullZone, storageZoneId } from "@/bunny.ts";
import { type Config, CONFIG_FILE } from "@/config.ts";
import { log } from "@/log.ts";

export async function destroy(
  apiKey: string,
  config: Config,
  { yes, interactive }: { yes?: boolean; interactive: boolean },
) {
  if (!yes) {
    if (!interactive) {
      throw new Error(
        `destroy deletes the pull zone, storage zone and every file of ${config.name}. Run it with --yes to confirm.`,
      );
    }

    await input({
      message: `This deletes the pull zone, storage zone, all files and ${CONFIG_FILE}. Type ${config.name} to confirm`,
      validate: (v) => v === config.name || `Type ${config.name} to confirm`,
    });
  }

  const pullZone = await getPullZone(apiKey, config.pullZoneId).catch((error: unknown) => {
    if (isNotFound(error)) return undefined;
    throw error;
  });

  if (pullZone) {
    const zoneId = storageZoneId(pullZone);
    log.step(`Deleting storage zone ${config.name} (${zoneId}) and every file in it`);
    await deleteIfExists(apiKey, `/storagezone/${zoneId}`);

    log.step(`Deleting pull zone ${config.name} (${config.pullZoneId})`);
    await deleteIfExists(apiKey, `/pullzone/${config.pullZoneId}`);
  } else {
    log.warn(
      `Pull zone ${config.pullZoneId} is already gone, so its storage zone cannot be found. If a storage zone named ${config.name} is left, delete it in the bunny.net dashboard.`,
    );
  }

  await rm(CONFIG_FILE, { force: true });
  log.success(`Deleted ${config.name} from bunny.net and removed ${CONFIG_FILE}`);
}

async function deleteIfExists(apiKey: string, path: string) {
  try {
    await api(apiKey, { method: "DELETE", path });
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function isNotFound(error: unknown) {
  return error instanceof ApiError && error.status === 404;
}
