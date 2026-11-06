import { createHash } from "node:crypto";
import { openAsBlob } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import {
  api,
  checkRuleLimit,
  dashboardUrl,
  ensureDomains,
  findHostname,
  geoZoneFlags,
  getPullZone,
  getStorageZone,
  isConnected,
  ORBITPUSH_DIR,
  pool,
  purgeCache,
  type PullZone,
  STALE_RECORD,
  StaleRecord,
  type StorageZone,
  storage,
  syncRules,
} from "@/bunny.ts";
import type { Config } from "@/config.ts";
import { isMissing } from "@/files.ts";
import { count, log, style } from "@/log.ts";
import { managedRules } from "@/rules.ts";

const RULE_FILES = ["_headers", "_redirects"];
const STALE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export async function deploy(
  apiKey: string,
  config: Config,
  { pruneHostnames = false }: { pruneHostnames?: boolean } = {},
) {
  const pullZone = await getPullZone(apiKey, config.pullZoneId);
  const zone = await getStorageZone(apiKey, pullZone);
  logTarget(config, zone, pullZone);

  const files = await readOutput(config.outputDir, {
    migrated: config.redirects.length > 0 || config.headers.length > 0,
  });
  if (!files.has("index.html")) log.warn(`No index.html in ${config.outputDir}`);

  const { rules: allRules, spa, warnings } = managedRules(config, { aliasRedirects: true });
  for (const warning of warnings) log.warn(warning);
  checkRuleLimit(pullZone, allRules);

  log.status("Comparing with storage zone");
  const bucket = storage(zone);
  const [remote, record] = await Promise.all([
    bucket.list(),
    bucket.read(STALE_RECORD, StaleRecord),
  ]);
  const changed = [...files].filter(
    ([path, file]) => remote.get(path)?.toUpperCase() !== file.checksum,
  );
  const { expired, kept } = partitionStale(
    [...remote.keys()].filter((path) => !files.has(path) && !path.startsWith(ORBITPUSH_DIR)),
    record,
    new Date(),
  );

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

  const { url, connected } = await applySettings(apiKey, {
    config,
    zone,
    pullZone,
    spa,
    has404: files.has("404.html"),
    pruneHostnames,
  });
  if (config.domain && config.aliases.length && !connected) {
    log.warn(
      `${config.aliases.join(", ")} will redirect to ${config.domain} once it has HTTPS. Run \`orbitpush domains add ${config.domain}\` to finish it.`,
    );
  }

  const ruleChanges = await syncRules(
    apiKey,
    pullZone,
    managedRules(config, { aliasRedirects: connected }).rules,
  );

  if (expired.length) {
    log.status(`Deleting ${count(expired.length, "stale file")}`);
    await pool(expired, 8, (path) => bucket.delete(path));
  }

  const nextRecord = JSON.stringify({ version: 1, stale: kept } satisfies StaleRecord);
  if ((record || Object.keys(kept).length) && nextRecord !== JSON.stringify(record)) {
    await bucket.put({
      path: STALE_RECORD,
      data: new Blob([nextRecord], { type: "application/json" }),
      checksum: createHash("sha256").update(nextRecord).digest("hex"),
    });
  }

  await purgeCache(apiKey, config.pullZoneId);

  logChanges("Files", [
    ["uploaded", changed.length],
    ["kept", Object.keys(kept).length],
    ["deleted", expired.length],
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

function logTarget(config: Config, zone: StorageZone, pullZone: PullZone) {
  const url = isConnected(pullZone, config.domain)
    ? `https://${findHostname(pullZone, config.domain)?.Value}`
    : `https://${pullZone.Name}.b-cdn.net`;
  const replicas = config.replicationRegions.filter((region) => region !== config.region);
  const regions = replicas.length
    ? `${config.region}, replicated to ${replicas.join(", ")}`
    : config.region;

  log.step(`Deploying ${style("bold", config.outputDir)} to ${style("bold", url)}`);
  const lines: [string, string][] =
    zone.Name === config.name && pullZone.Name === config.name
      ? [["Project", `${config.name} (${regions})`]]
      : [
          ["Storage zone", `${zone.Name} (${regions})`],
          ["Pull zone", pullZone.Name],
        ];
  if (config.aliases.length) lines.push(["Aliases", config.aliases.join(", ")]);
  lines.push(["bunny.net", dashboardUrl(config.pullZoneId)]);

  const width = Math.max(...lines.map(([label]) => label.length));
  for (const [label, value] of lines) log.detail(`${label.padEnd(width)}  ${value}`);
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

    if (path.startsWith(ORBITPUSH_DIR)) {
      log.warn(
        `${path} is not uploaded: ${ORBITPUSH_DIR} in the storage zone belongs to orbitpush.`,
      );
      continue;
    }

    const checksum = createHash("sha256")
      .update(await readFile(absolute))
      .digest("hex")
      .toUpperCase();
    files.set(path, { absolute, checksum });
  }

  return files;
}

function partitionStale(paths: string[], record: StaleRecord | undefined, now: Date) {
  const expired: string[] = [];
  const kept = new Map<string, string>();
  for (const path of [...paths].sort()) {
    const since =
      record && Object.hasOwn(record.stale, path) ? record.stale[path] : now.toISOString();
    if (now.getTime() - Date.parse(since) > STALE_GRACE_MS) expired.push(path);
    else kept.set(path, since);
  }

  return { expired, kept: Object.fromEntries(kept) };
}

function isHtml(path: string) {
  return path.endsWith(".html");
}

async function applySettings(
  apiKey: string,
  {
    config,
    zone,
    pullZone,
    spa,
    has404,
    pruneHostnames,
  }: {
    config: Config;
    zone: StorageZone;
    pullZone: PullZone;
    spa: boolean;
    has404: boolean;
    pruneHostnames: boolean;
  },
) {
  log.status("Applying settings");
  await api(apiKey, {
    method: "POST",
    path: `/storagezone/${zone.Id}`,
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
