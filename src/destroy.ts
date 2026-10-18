import { rm } from "node:fs/promises";

import { input } from "@inquirer/prompts";

import { api, ApiError } from "./bunny.ts";
import { type Config, CONFIG_FILE } from "./config.ts";
import { log } from "./log.ts";

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

  log.step(`Deleting pull zone ${config.name} (${config.pullZoneId})`);
  await deleteIfExists(apiKey, `/pullzone/${config.pullZoneId}`);

  log.step(`Deleting storage zone ${config.name} (${config.storageZoneId})`);
  await deleteIfExists(apiKey, `/storagezone/${config.storageZoneId}`);

  await rm(CONFIG_FILE, { force: true });
  log.success(`Deleted ${config.name} from bunny.net and removed ${CONFIG_FILE}`);
}

async function deleteIfExists(apiKey: string, path: string) {
  try {
    await api(apiKey, { method: "DELETE", path });
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) throw error;
  }
}
