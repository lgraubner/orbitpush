import { api, getPullZone, purgeCache } from "./bunny.ts";
import type { Config } from "./config.ts";
import { log } from "./log.ts";
import { DISABLED_RULE } from "./rules.ts";

export async function enable(apiKey: string, config: Config) {
  const pullZone = await getPullZone(apiKey, config.pullZoneId);
  const blocks = pullZone.EdgeRules.filter((r) => r.Description === DISABLED_RULE);
  if (!blocks.length) {
    log.success(`${config.name} is already enabled`);
    return;
  }

  log.step("Removing the block on all requests");
  for (const block of blocks) {
    await api(apiKey, {
      method: "DELETE",
      path: `/pullzone/${config.pullZoneId}/edgerules/${block.Guid}`,
    });
  }

  await purgeCache(apiKey, config.pullZoneId);
  log.success(`Enabled ${config.name}`);
}
