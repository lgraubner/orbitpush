import { createHash } from "node:crypto";
import { openAsBlob } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { api, apiJson, geoZoneFlags, pool, PullZone, StorageZone, storage } from "./bunny.ts";
import type { Config } from "./config.ts";
import { isMissing, readIfExists } from "./files.ts";
import { errorMessage, log } from "./log.ts";
import { type EdgeRule, parseHeaders, parseRedirects, RULE_PREFIX } from "./rules.ts";

const RULE_FILES = ["_headers", "_redirects"];

export async function deploy(apiKey: string, config: Config) {
  const zone = await apiJson(apiKey, {
    schema: StorageZone,
    method: "GET",
    path: `/storagezone/${config.storageZoneId}`,
  });
  const files = await readOutput(config.outputDir);
  if (!files.has("index.html")) log.warn(`No index.html in ${config.outputDir}`);

  const rules = await readRules(config.outputDir);

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

  await applySettings(apiKey, { config, has404: files.has("404.html") });
  await syncRules(apiKey, config.pullZoneId, rules);

  if (stale.length) {
    log.step(`Deleting ${stale.length} stale files`);
    await pool(stale, 8, (path) => bucket.delete(path));
  }

  log.step("Purging cache");
  await api(apiKey, { method: "POST", path: `/pullzone/${config.pullZoneId}/purgeCache` });
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

  return [...redirects.rules, ...headers.rules];
}

async function applySettings(
  apiKey: string,
  { config, has404 }: { config: Config; has404: boolean },
) {
  log.step("Applying settings");
  await api(apiKey, {
    method: "POST",
    path: `/storagezone/${config.storageZoneId}`,
    body: {
      ReplicationRegions: config.replicationRegions.filter((region) => region !== config.region),
      Rewrite404To200: config.spa,
      Custom404FilePath: config.spa ? "/index.html" : has404 ? "/404.html" : "",
    },
  });
  await api(apiKey, {
    method: "POST",
    path: `/pullzone/${config.pullZoneId}`,
    body: geoZoneFlags(config.geoZones),
  });
  await ensureDomains(apiKey, config);
}

export async function ensureDomains(apiKey: string, config: Config) {
  const pullZone = await apiJson(apiKey, {
    schema: PullZone,
    method: "GET",
    path: `/pullzone/${config.pullZoneId}`,
  });
  const cdnHost = `${pullZone.Name}.b-cdn.net`;

  for (const domain of config.domains.map((d) => d.toLowerCase())) {
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
  const pullZone = await apiJson(apiKey, {
    schema: PullZone,
    method: "GET",
    path: `/pullzone/${pullZoneId}`,
  });
  const wanted = new Map<string, EdgeRule & { OrderIndex: number }>();
  rules.forEach((rule, OrderIndex) => {
    if (!wanted.has(rule.Description)) wanted.set(rule.Description, { ...rule, OrderIndex });
  });

  const kept = new Map<string, { Guid: string; OrderIndex: number }>();
  const removed = pullZone.EdgeRules.filter((r) => {
    if (!r.Description?.startsWith(RULE_PREFIX)) return false;
    if (!wanted.has(r.Description) || kept.has(r.Description)) return true;

    kept.set(r.Description, r);
    return false;
  });
  const added = [...wanted.values()].filter((r) => !kept.has(r.Description));
  const moved = [...wanted.values()].flatMap((rule) => {
    const deployed = kept.get(rule.Description);
    return deployed && deployed.OrderIndex !== rule.OrderIndex
      ? [{ ...rule, Guid: deployed.Guid }]
      : [];
  });
  if (!added.length && !moved.length && !removed.length) return;

  const movedNote = moved.length ? ` ~${moved.length}` : "";
  log.step(`Updating edge rules (+${added.length}${movedNote} -${removed.length})`);

  for (const rule of [...added, ...moved]) {
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
