import { api, getPullZone, purgeCache } from "./bunny.ts";
import type { Config } from "./config.ts";
import { log } from "./log.ts";
import { DISABLED_RULE, disabledRule } from "./rules.ts";

export async function disable(apiKey: string, config: Config) {
  const pullZone = await getPullZone(apiKey, config.pullZoneId);
  if (pullZone.EdgeRules.some((r) => r.Description === DISABLED_RULE)) {
    log.success(`${config.name} is already disabled`);
    return;
  }

  log.step("Blocking all requests");
  await api(apiKey, {
    method: "POST",
    path: `/pullzone/${config.pullZoneId}/edgerules/addOrUpdate`,
    body: disabledRule(),
  });

  await purgeCache(apiKey, config.pullZoneId);
  log.success(`Disabled ${config.name}. Run \`orbitpush enable\` to serve it again.`);
}
