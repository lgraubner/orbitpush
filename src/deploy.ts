import { createHash } from "node:crypto";
import { openAsBlob } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, sep } from "node:path";

import { api, apiJson, geoZoneFlags, PullZone, StorageZone, storage } from "./bunny.ts";
import type { Config } from "./config.ts";
import { isMissing, readIfExists } from "./files.ts";
import { errorMessage, log } from "./log.ts";
import { type EdgeRule, parseHeaders, parseRedirects, RULE_PREFIX } from "./rules.ts";

const RULE_FILES = ["_headers", "_redirects"];

export async function deploy(apiKey: string, config: Config) {
  const zone = await apiJson(StorageZone, apiKey, "GET", `/storagezone/${config.storageZoneId}`);
  const files = await readOutput(config.outputDir);
  if (!files.has("index.html")) log.warn(`No index.html in ${config.outputDir}`);

  const rules = await readRules(config.outputDir);

  log.step("Comparing with storage zone");
  const bucket = storage(zone);
  const remote = await bucket.list();
  const changed = [...files].filter(
    ([path, file]) => remote.get(path)?.toUpperCase() !== file.checksum,
  );
  changed.sort(([a], [b]) => htmlLast(a, b));
  const stale = [...remote.keys()].filter((path) => !files.has(path));

  log.step(`Uploading ${changed.length} of ${files.size} files`);
  await pool(changed, 8, async ([path, file]) => {
    await bucket.put(path, await openAsBlob(file.absolute), file.checksum);
    log.detail(path);
  });

  await applySettings(apiKey, config, files.has("404.html"));
  await syncRules(apiKey, config.pullZoneId, rules);

  if (stale.length) {
    log.step(`Deleting ${stale.length} stale files`);
    await pool(stale, 8, (path) => bucket.delete(path));
  }

  log.step("Purging cache");
  await api(apiKey, "POST", `/pullzone/${config.pullZoneId}/purgeCache`);
}

async function readOutput(dir: string) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(
    (error: unknown) => {
      if (isMissing(error))
        throw new Error(`Output directory "${dir}" not found. Did you run the build?`);
      throw error;
    },
  );
  const files = new Map<string, { absolute: string; checksum: string }>();

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const absolute = join(entry.parentPath, entry.name);
    const path = absolute
      .slice(dir.replace(/[\\/]$/, "").length + 1)
      .split(sep)
      .join("/");
    if (RULE_FILES.includes(path)) continue;

    const checksum = createHash("sha256")
      .update(await readFile(absolute))
      .digest("hex")
      .toUpperCase();
    files.set(path, { absolute, checksum });
  }

  return files;
}

function htmlLast(a: string, b: string) {
  return Number(a.endsWith(".html")) - Number(b.endsWith(".html"));
}

async function readRules(dir: string) {
  const redirects = parseRedirects(await readIfExists(join(dir, "_redirects")));
  const headers = parseHeaders(await readIfExists(join(dir, "_headers")));

  for (const warning of [...redirects.warnings, ...headers.warnings]) log.warn(warning);

  return [...redirects.rules, ...headers.rules];
}

export async function applySettings(apiKey: string, config: Config, has404: boolean) {
  log.step("Applying settings");
  await api(apiKey, "POST", `/storagezone/${config.storageZoneId}`, {
    ReplicationRegions: config.replicationRegions.filter((region) => region !== config.region),
    Rewrite404To200: config.spa,
    Custom404FilePath: config.spa ? "/index.html" : has404 ? "/404.html" : "",
  });
  await api(apiKey, "POST", `/pullzone/${config.pullZoneId}`, geoZoneFlags(config.geoZones));
  await ensureDomains(apiKey, config);
}

export async function ensureDomains(apiKey: string, config: Config) {
  const pullZone = await apiJson(PullZone, apiKey, "GET", `/pullzone/${config.pullZoneId}`);
  const cdnHost = `${pullZone.Name}.b-cdn.net`;

  for (const domain of config.domains.map((d) => d.toLowerCase())) {
    let hostname = pullZone.Hostnames.find((h) => h.Value.toLowerCase() === domain);
    if (!hostname) {
      await api(apiKey, "POST", `/pullzone/${config.pullZoneId}/addHostname`, { Hostname: domain });
      hostname = { Value: domain, HasCertificate: false, ForceSSL: false };
    }

    if (!hostname.HasCertificate) {
      const query = `hostname=${encodeURIComponent(domain)}`;
      const failure = await api(apiKey, "GET", `/pullzone/loadFreeCertificate?${query}`).then(
        () => undefined,
        (error: unknown) => errorMessage(error),
      );
      if (failure) {
        log.warn(
          `No SSL certificate for ${domain} yet. Point a CNAME record to ${cdnHost} and deploy again. bunny.net: ${failure}`,
        );
        continue;
      }
    }

    if (!hostname.ForceSSL) {
      await api(apiKey, "POST", `/pullzone/${config.pullZoneId}/setForceSSL`, {
        Hostname: domain,
        ForceSSL: true,
      });
    }
  }

  return cdnHost;
}

async function syncRules(apiKey: string, pullZoneId: number, rules: EdgeRule[]) {
  const pullZone = await apiJson(PullZone, apiKey, "GET", `/pullzone/${pullZoneId}`);
  const existing = pullZone.EdgeRules.filter((r) => r.Description?.startsWith(RULE_PREFIX));
  const existingDescriptions = new Set(existing.map((r) => r.Description));
  const wanted = new Set(rules.map((r) => r.Description));
  const added = rules.filter((r) => !existingDescriptions.has(r.Description));
  const removed = existing.filter((r) => !wanted.has(r.Description ?? ""));
  if (!added.length && !removed.length) return;

  log.step(`Updating edge rules (+${added.length} -${removed.length})`);

  for (const rule of added) {
    await api(apiKey, "POST", `/pullzone/${pullZoneId}/edgerules/addOrUpdate`, rule);
  }

  for (const rule of removed) {
    await api(apiKey, "DELETE", `/pullzone/${pullZoneId}/edgerules/${rule.Guid}`);
  }
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<unknown>) {
  let next = 0;

  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}
