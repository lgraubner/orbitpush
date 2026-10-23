import { createHash } from "node:crypto";
import { openAsBlob } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import {
  api,
  apiJson,
  ensureDomains,
  geoZoneFlags,
  getPullZone,
  pool,
  purgeCache,
  type PullZone,
  StorageZone,
  storage,
} from "./bunny.ts";
import type { Config } from "./config.ts";
import { isMissing } from "./files.ts";
import { log, style } from "./log.ts";
import {
  DISABLED_RULE,
  domainRules,
  MAX_EDGE_RULES,
  type EdgeRule,
  isAliasRule,
  isManaged,
  headerRules,
  redirectRules,
  trailingSlashRule,
} from "./rules.ts";

const RULE_FILES = ["_headers", "_redirects"];

export async function deploy(
  apiKey: string,
  config: Config,
  { pruneHostnames = false }: { pruneHostnames?: boolean } = {},
) {
  const [zone, pullZone] = await Promise.all([
    apiJson(apiKey, {
      schema: StorageZone,
      method: "GET",
      path: `/storagezone/${config.storageZoneId}`,
    }),
    getPullZone(apiKey, config.pullZoneId),
  ]);
  logTarget(config, zone, pullZone);

  const files = await readOutput(config.outputDir, {
    migrated: config.redirects.length > 0 || config.headers.length > 0,
  });
  if (!files.has("index.html")) log.warn(`No index.html in ${config.outputDir}`);

  const { rules: configRules, spa } = readRules(config);
  const rules = [
    ...domainRules(config),
    ...configRules,
    ...trailingSlashRule(config.trailingSlash ?? (spa ? "ignore" : "always")),
  ];

  checkRuleLimit(pullZone, rules);

  log.status("Comparing with storage zone");
  const bucket = storage(zone);
  const remote = await bucket.list();
  const changed = [...files].filter(
    ([path, file]) => remote.get(path)?.toUpperCase() !== file.checksum,
  );
  const stale = [...remote.keys()].filter((path) => !files.has(path));

  let uploaded = 0;
  const upload = async ([path, file]: (typeof changed)[number]) => {
    await bucket.put({ path, data: await openAsBlob(file.absolute), checksum: file.checksum });
    log.status(`Uploading ${++uploaded} of ${count(changed.length, "file")}`);
  };
  await pool(
    changed.filter(([path]) => !isHtml(path)),
    8,
    upload,
  );
  await pool(
    changed.filter(([path]) => isHtml(path)),
    8,
    upload,
  );

  const url = await applySettings(apiKey, {
    config,
    pullZone,
    spa,
    has404: files.has("404.html"),
    pruneHostnames,
  });
  const ruleChanges = await syncRules(apiKey, pullZone, rules);

  if (stale.length) {
    log.status(`Deleting ${count(stale.length, "stale file")}`);
    await pool(stale, 8, (path) => bucket.delete(path));
  }

  await purgeCache(apiKey, config.pullZoneId);

  logChanges("Files", [
    ["uploaded", changed.length],
    ["deleted", stale.length],
    ["unchanged", files.size - changed.length],
  ]);
  logChanges("Edge rules", [
    ["added", ruleChanges.added],
    ["removed", ruleChanges.removed],
    ["kept", ruleChanges.kept],
  ]);

  return url;
}

function logChanges(subject: string, counts: [string, number][]) {
  const parts = counts.filter(([, n]) => n > 0).map(([verb, n]) => `${n} ${verb}`);
  if (parts.length) log.step(`${subject}: ${parts.join(", ")}`);
}

function count(n: number, noun: string) {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function logTarget(config: Config, zone: StorageZone, pullZone: PullZone) {
  const domain = pullZone.Hostnames.find(
    (h) => h.HasCertificate && h.Value.toLowerCase() === config.domain?.toLowerCase(),
  );
  const url = `https://${domain?.Value ?? `${pullZone.Name}.b-cdn.net`}`;
  const replicas = config.replicationRegions.filter((region) => region !== config.region);
  const regions = replicas.length
    ? `${config.region}, replicated to ${replicas.join(", ")}`
    : config.region;

  log.step(`Deploying ${style("bold", config.outputDir)} to ${style("bold", url)}`);
  log.detail(`Storage zone  ${zone.Name} (${regions})`);
  log.detail(`Pull zone     ${pullZone.Name}`);
  if (config.aliases.length) log.detail(`Aliases       ${config.aliases.join(", ")}`);
}

async function readOutput(dir: string, { migrated }: { migrated: boolean }) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(
    (error: unknown) => {
      if (isMissing(error))
        throw new Error(`Output directory "${dir}" not found. Did you run the build?`);
      throw error;
    },
  );
  const files = new Map<string, { absolute: string; checksum: string }>();

  for (const entry of entries) {
    const absolute = join(entry.parentPath, entry.name);
    const path = relative(dir, absolute).split(sep).join("/");
    if (entry.isSymbolicLink()) {
      const target = await stat(absolute).catch((error: unknown) => {
        if (isMissing(error)) return undefined;
        throw error;
      });
      if (!target) {
        log.warn(`${path} links to a file that does not exist, so deploy skips it.`);
        continue;
      }

      if (target.isDirectory()) {
        log.warn(`${path} links to a directory, which deploy does not follow. Copy it instead.`);
        continue;
      }
    }

    // Netlify reads these files and never serves them, and _headers can hold passwords
    if (RULE_FILES.includes(path)) {
      log.warn(
        migrated
          ? `${path} is not read: its rules live in orbitpush.json.`
          : `${path} is not read. Run \`orbitpush migrate-netlify\` to copy its rules to orbitpush.json.`,
      );
      continue;
    }

    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const checksum = createHash("sha256")
      .update(await readFile(absolute))
      .digest("hex")
      .toUpperCase();
    files.set(path, { absolute, checksum });
  }

  return files;
}

function isHtml(path: string) {
  return path.endsWith(".html");
}

function readRules(config: Config) {
  const redirects = redirectRules(config.redirects);
  const headers = headerRules(config.headers);

  for (const warning of [...redirects.warnings, ...headers.warnings]) log.warn(warning);

  return { rules: [...redirects.rules, ...headers.rules], spa: redirects.spa };
}

async function applySettings(
  apiKey: string,
  {
    config,
    pullZone,
    spa,
    has404,
    pruneHostnames,
  }: { config: Config; pullZone: PullZone; spa: boolean; has404: boolean; pruneHostnames: boolean },
) {
  log.status("Applying settings");
  await api(apiKey, {
    method: "POST",
    path: `/storagezone/${config.storageZoneId}`,
    body: {
      ReplicationRegions: config.replicationRegions.filter((region) => region !== config.region),
      Rewrite404To200: spa,
      Custom404FilePath: spa ? "/index.html" : has404 ? "/404.html" : "",
    },
  });
  await api(apiKey, {
    method: "POST",
    path: `/pullzone/${config.pullZoneId}`,
    // bunny.net shares one cache across hostnames and caches the headers edge rules set, so
    // without this the noindex of b-cdn.net is served on the domain from cache.
    // Unless CacheControlPublicMaxAgeOverride is set, bunny.net tells browsers to cache every
    // file for its 30-day edge cache time, and a purge does not reach browsers.
    body: {
      ...geoZoneFlags(config.geoZones),
      EnableHostnameVary: true,
      CacheControlPublicMaxAgeOverride: 0,
    },
  });
  return ensureDomains(apiKey, config, pullZone, { prune: pruneHostnames });
}

function checkRuleLimit(pullZone: PullZone, rules: EdgeRule[]) {
  const unmanaged = pullZone.EdgeRules.filter((r) => !isManaged(r));
  const managed = new Set(rules.map((r) => r.Description)).size;
  // bunny.net rejects every edge rule write on a full zone, updates included
  if (managed + unmanaged.length < MAX_EDGE_RULES) return;

  throw new Error(
    `This deploy needs ${managed + unmanaged.length} edge rules (${managed} from orbitpush, ${unmanaged.length} others on the pull zone). bunny.net allows ${MAX_EDGE_RULES} edge rules per pull zone and accepts no change to a full one, so a deploy can use ${MAX_EDGE_RULES - 1}. Remove entries from redirects or headers in orbitpush.json, or ask bunny.net support to raise the limit.`,
  );
}

async function syncRules(apiKey: string, pullZone: PullZone, rules: EdgeRule[]) {
  const pullZoneId = pullZone.Id;
  if (pullZone.EdgeRules.some((r) => r.Description === DISABLED_RULE)) {
    log.warn("The site is disabled. Run `orbitpush enable` to serve it again.");
  }

  const wanted = new Map<string, EdgeRule & { OrderIndex: number }>();
  rules.forEach((rule, OrderIndex) => {
    if (!wanted.has(rule.Description)) wanted.set(rule.Description, { ...rule, OrderIndex });
  });

  const kept = new Map<string, { Guid: string; OrderIndex: number }>();
  const removed = pullZone.EdgeRules.filter((r) => {
    if (!isManaged(r)) return false;
    if (!wanted.has(r.Description) || kept.has(r.Description)) return true;

    kept.set(r.Description, r);
    return false;
  });
  const writes = [...wanted.values()].map((rule) => {
    const deployed = kept.get(rule.Description);
    return deployed ? { ...rule, Guid: deployed.Guid } : rule;
  });
  const added = writes.length - kept.size;
  const changes = { added, removed: removed.length, kept: kept.size };
  if (!writes.length && !removed.length) return changes;

  log.status("Updating edge rules");

  const remove = async (rules: typeof removed) => {
    for (const rule of rules) {
      await api(apiKey, {
        method: "DELETE",
        path: `/pullzone/${pullZoneId}/edgerules/${rule.Guid}`,
      });
    }
  };
  // bunny.net rejects every write on a full zone, so delete first when adding first would fill it
  const deleteFirst = pullZone.EdgeRules.length + added >= MAX_EDGE_RULES;
  const first = deleteFirst ? removed : removed.filter((r) => isAliasRule(r.Description));
  await remove(first);

  for (const rule of writes) {
    await api(apiKey, {
      method: "POST",
      path: `/pullzone/${pullZoneId}/edgerules/addOrUpdate`,
      body: rule,
    });
  }

  await remove(removed.filter((r) => !first.includes(r)));
  return changes;
}
