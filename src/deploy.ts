import { createHash } from "node:crypto";
import { openAsBlob } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import {
  api,
  apiJson,
  geoZoneFlags,
  getPullZone,
  pool,
  purgeCache,
  StorageZone,
  storage,
} from "./bunny.ts";
import type { Config } from "./config.ts";
import { isMissing, readIfExists } from "./files.ts";
import { errorMessage, log } from "./log.ts";
import {
  DISABLED_RULE,
  domainRules,
  type EdgeRule,
  parseHeaders,
  parseRedirects,
  RULE_PREFIX,
  trailingSlashRule,
} from "./rules.ts";

const RULE_FILES = ["_headers", "_redirects"];

export async function deploy(apiKey: string, config: Config) {
  const zone = await apiJson(apiKey, {
    schema: StorageZone,
    method: "GET",
    path: `/storagezone/${config.storageZoneId}`,
  });
  const files = await readOutput(config.outputDir);
  if (!files.has("index.html")) log.warn(`No index.html in ${config.outputDir}`);

  const { rules: fileRules, spa } = await readRules(config.outputDir);
  const rules = [
    ...domainRules(config),
    ...fileRules,
    ...trailingSlashRule(config.trailingSlash ?? (spa ? "ignore" : "always")),
  ];

  log.step("Comparing with storage zone");
  const bucket = storage(zone);
  const remote = await bucket.list();
  const changed = [...files].filter(
    ([path, file]) => remote.get(path)?.toUpperCase() !== file.checksum,
  );
  const stale = [...remote.keys()].filter((path) => !files.has(path));

  log.step(`Uploading ${changed.length} of ${files.size} files`);
  const upload = async ([path, file]: (typeof changed)[number]) => {
    await bucket.put({ path, data: await openAsBlob(file.absolute), checksum: file.checksum });
    log.detail(path);
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

  await applySettings(apiKey, { config, spa, has404: files.has("404.html") });
  await syncRules(apiKey, config.pullZoneId, rules);

  if (stale.length) {
    log.step(`Deleting ${stale.length} stale files`);
    await pool(stale, 8, (path) => bucket.delete(path));
  }

  await purgeCache(apiKey, config.pullZoneId);
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
    const path = relative(dir, absolute).split(sep).join("/");
    if (RULE_FILES.includes(path)) continue;

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

async function readRules(dir: string) {
  const redirects = parseRedirects(await readIfExists(join(dir, "_redirects")));
  const headers = parseHeaders(await readIfExists(join(dir, "_headers")));

  for (const warning of [...redirects.warnings, ...headers.warnings]) log.warn(warning);

  return { rules: [...redirects.rules, ...headers.rules], spa: redirects.spa };
}

async function applySettings(
  apiKey: string,
  { config, spa, has404 }: { config: Config; spa: boolean; has404: boolean },
) {
  log.step("Applying settings");
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
  await ensureDomains(apiKey, config);
}

export async function ensureDomains(apiKey: string, config: Config) {
  const pullZone = await getPullZone(apiKey, config.pullZoneId);
  const cdnHost = `${pullZone.Name}.b-cdn.net`;

  const hostnames = config.domain ? [config.domain, ...config.aliases] : [];
  for (const domain of hostnames.map((d) => d.toLowerCase())) {
    let hostname = pullZone.Hostnames.find((h) => h.Value.toLowerCase() === domain);
    if (!hostname) {
      await api(apiKey, {
        method: "POST",
        path: `/pullzone/${config.pullZoneId}/addHostname`,
        body: { Hostname: domain },
      });
      hostname = { Value: domain, HasCertificate: false, ForceSSL: false };
    }

    if (!hostname.HasCertificate) {
      const query = `hostname=${encodeURIComponent(domain)}`;
      const failure = await api(apiKey, {
        method: "GET",
        path: `/pullzone/loadFreeCertificate?${query}`,
      }).then(
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
      await api(apiKey, {
        method: "POST",
        path: `/pullzone/${config.pullZoneId}/setForceSSL`,
        body: {
          Hostname: domain,
          ForceSSL: true,
        },
      });
    }
  }

  return cdnHost;
}

async function syncRules(apiKey: string, pullZoneId: number, rules: EdgeRule[]) {
  const pullZone = await getPullZone(apiKey, pullZoneId);
  if (pullZone.EdgeRules.some((r) => r.Description === DISABLED_RULE)) {
    log.warn("The site is disabled. Run `orbitpush enable` to serve it again.");
  }

  const wanted = new Map<string, EdgeRule & { OrderIndex: number }>();
  rules.forEach((rule, OrderIndex) => {
    if (!wanted.has(rule.Description)) wanted.set(rule.Description, { ...rule, OrderIndex });
  });

  const kept = new Map<string, { Guid: string; OrderIndex: number }>();
  const removed = pullZone.EdgeRules.filter((r) => {
    if (!r.Description?.startsWith(RULE_PREFIX) || r.Description === DISABLED_RULE) return false;
    if (!wanted.has(r.Description) || kept.has(r.Description)) return true;

    kept.set(r.Description, r);
    return false;
  });
  const writes = [...wanted.values()].map((rule) => {
    const deployed = kept.get(rule.Description);
    return deployed ? { ...rule, Guid: deployed.Guid } : rule;
  });
  if (!writes.length && !removed.length) return;

  const added = writes.length - kept.size;
  log.step(`Updating edge rules (+${added} ~${kept.size} -${removed.length})`);

  for (const rule of writes) {
    await api(apiKey, {
      method: "POST",
      path: `/pullzone/${pullZoneId}/edgerules/addOrUpdate`,
      body: rule,
    });
  }

  for (const rule of removed) {
    await api(apiKey, { method: "DELETE", path: `/pullzone/${pullZoneId}/edgerules/${rule.Guid}` });
  }
}
