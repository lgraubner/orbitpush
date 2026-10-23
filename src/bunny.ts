import { type Config, CONFIG_FILE, GEO_ZONES, type GeoZone } from "./config.ts";
import { errorMessage, log } from "./log.ts";
import { DISABLED_RULE, type EdgeRule, isAliasRule, isManaged, MAX_EDGE_RULES } from "./rules.ts";
import { issues, z } from "./zod.ts";

export const API_KEY_URL = "https://dash.bunny.net/account/api-key";

export const PullZone = z.object({
  Id: z.int(),
  Name: z.string(),
  Hostnames: z.array(
    z.object({ Value: z.string(), HasCertificate: z.boolean(), ForceSSL: z.boolean() }),
  ),
  EdgeRules: z.array(
    z.object({ Guid: z.string(), Description: z.nullable(z.string()), OrderIndex: z.int() }),
  ),
});

export type PullZone = z.infer<typeof PullZone>;

export const StorageZone = z.object({
  Id: z.int(),
  Name: z.string(),
  Password: z.string(),
  StorageHostname: z.string(),
});

export type StorageZone = z.infer<typeof StorageZone>;

export const CreatedZone = z.object({ Id: z.int() });
export type CreatedZone = z.infer<typeof CreatedZone>;

const Listing = z.array(
  z.object({
    ObjectName: z.string(),
    IsDirectory: z.boolean(),
    Checksum: z.optional(z.nullable(z.string())),
  }),
);

const ErrorBody = z.object({ Message: z.string() });

const REQUEST_TIMEOUT_MS = 120_000;
const MIN_UPLOAD_BYTES_PER_MS = 100;

export function envApiKey() {
  return process.env.BUNNY_API_KEY?.trim() || undefined;
}

export function apiKeyFromEnv() {
  const key = envApiKey();
  if (!key) throw new Error(`BUNNY_API_KEY is not set. Create an API key at ${API_KEY_URL}`);

  return key;
}

export function geoZoneFlags(geoZones: GeoZone[]) {
  return Object.fromEntries(
    GEO_ZONES.map((zone) => [`EnableGeoZone${zone}`, geoZones.includes(zone)]),
  );
}

type ApiRequest = { method: "GET" | "POST" | "DELETE"; path: string; body?: unknown };

export async function api(apiKey: string, { method, path, body }: ApiRequest) {
  const response = await fetch(`https://api.bunny.net${path}`, {
    method,
    headers: {
      AccessKey: apiKey,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch((error: unknown) => {
    throw new Error(`${method} ${path} failed: ${errorMessage(error)}`);
  });
  if (!response.ok) {
    throw new ApiError(`${method} ${path} failed: ${await errorText(response)}`, response.status);
  }

  return response;
}

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function apiJson<T>(
  apiKey: string,
  { schema, ...request }: ApiRequest & { schema: z.ZodMiniType<T> },
) {
  const response = await api(apiKey, request);
  const json: unknown = await response.json().catch(() => undefined);

  return parseResponse(schema, json, `${request.method} ${request.path}`);
}

export function findHostname(pullZone: PullZone, host: string | undefined) {
  return pullZone.Hostnames.find((h) => h.Value.toLowerCase() === host?.toLowerCase());
}

export function isConnected(pullZone: PullZone, host: string | undefined) {
  return Boolean(findHostname(pullZone, host)?.HasCertificate);
}

export function getPullZone(apiKey: string, pullZoneId: number) {
  return apiJson(apiKey, { schema: PullZone, method: "GET", path: `/pullzone/${pullZoneId}` });
}

export async function ensureDomains(
  apiKey: string,
  config: Config,
  pullZone: PullZone,
  { prune = false }: { prune?: boolean } = {},
) {
  const cdnHost = `${pullZone.Name}.b-cdn.net`;
  const hostnames = (config.domain ? [config.domain, ...config.aliases] : []).map((host) =>
    host.toLowerCase(),
  );

  for (const { Value } of pullZone.Hostnames) {
    const host = Value.toLowerCase();
    if (host === cdnHost.toLowerCase() || hostnames.includes(host)) continue;

    if (prune) {
      await removeHostname(apiKey, config.pullZoneId, Value);
      continue;
    }

    log.warn(
      `${Value} is on the pull zone but not in ${CONFIG_FILE}, so it serves the site without a redirect. Run \`orbitpush domains add ${Value}\` to make it an alias, or \`orbitpush domains remove ${Value}\`.`,
    );
  }

  let url = `https://${cdnHost}`;
  for (const domain of hostnames) {
    const hostname = findHostname(pullZone, domain);
    if (!hostname) {
      await addHostname(apiKey, config.pullZoneId, domain);
      logDnsRecord(
        domain,
        cdnHost,
        `Add this DNS record, then run \`orbitpush domains add ${domain}\` to finish:`,
      );
    }

    const connection = await connectHostname(apiKey, config.pullZoneId, domain, hostname);
    if (connection.status === "dns" && hostname) {
      logDnsRecord(
        domain,
        cdnHost,
        `DNS for ${domain} does not point to bunny.net yet. Add this record, then run \`orbitpush domains add ${domain}\`:`,
      );
    } else if (connection.status === "failed" && hostname) {
      log.warn(`No SSL certificate for ${domain} yet. bunny.net: ${connection.reason}`);
    }

    if (connection.status === "connected" && domain === hostnames[0]) url = `https://${domain}`;
  }

  return { url, connected: url !== `https://${cdnHost}` };
}

export async function addHostname(apiKey: string, pullZoneId: number, host: string) {
  log.step(`Adding hostname ${host}`);
  await api(apiKey, {
    method: "POST",
    path: `/pullzone/${pullZoneId}/addHostname`,
    body: { Hostname: host },
  });
}

export async function removeHostname(apiKey: string, pullZoneId: number, host: string) {
  log.step(`Removing hostname ${host}`);
  await api(apiKey, {
    method: "DELETE",
    path: `/pullzone/${pullZoneId}/removeHostname`,
    body: { Hostname: host },
  });
}

export type Connection =
  | { status: "connected" }
  | { status: "dns" }
  | { status: "failed"; reason: string };

export async function connectHostname(
  apiKey: string,
  pullZoneId: number,
  host: string,
  hostname?: PullZone["Hostnames"][number],
): Promise<Connection> {
  if (!hostname?.HasCertificate) {
    const failure = await api(apiKey, {
      method: "GET",
      path: `/pullzone/loadFreeCertificate?hostname=${encodeURIComponent(host)}`,
    }).then(
      () => undefined,
      (error: unknown) => errorMessage(error),
    );
    // bunny.net answers HTTP 400 for every failed issue, so only its message tells DNS apart
    if (failure && /not pointing to our servers/i.test(failure)) return { status: "dns" };
    if (failure) return { status: "failed", reason: failure };
  }

  if (!hostname?.ForceSSL) {
    await api(apiKey, {
      method: "POST",
      path: `/pullzone/${pullZoneId}/setForceSSL`,
      body: { Hostname: host, ForceSSL: true },
    });
  }

  return { status: "connected" };
}

export function logDnsRecord(host: string, cdnHost: string, message: string) {
  log.warn(message);
  log.detail(`${host} CNAME ${cdnHost}`);
  if (host.split(".").length === 2) {
    log.detail("At the root of a domain, use ALIAS, ANAME or CNAME flattening instead of CNAME.");
  }
}

export async function purgeCache(apiKey: string, pullZoneId: number) {
  log.status("Purging cache");
  await api(apiKey, { method: "POST", path: `/pullzone/${pullZoneId}/purgeCache` });
}

const STORAGE_AUTH_ATTEMPTS = 7;
const STORAGE_AUTH_DELAY_MS = 5000;

export function storage(zone: StorageZone) {
  const base = `https://${zone.StorageHostname}/${encodeURIComponent(zone.Name)}/`;
  const url = (path: string) => base + path.split("/").map(encodeURIComponent).join("/");
  const request = async (
    method: string,
    path: string,
    init: { body?: Blob; headers?: Record<string, string>; signal?: AbortSignal } = {},
  ) => {
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(url(path), {
        ...init,
        method,
        headers: { AccessKey: zone.Password, ...init.headers },
      }).catch((error: unknown) => {
        throw new Error(`${method} /${path} failed: ${errorMessage(error)}`);
      });
      // bunny.net rejects a new storage zone's password for a few seconds after it is created
      if (response.status === 401 && attempt < STORAGE_AUTH_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, STORAGE_AUTH_DELAY_MS));
        continue;
      }

      if (!response.ok) throw new Error(`${method} /${path} failed: ${await errorText(response)}`);

      return response;
    }
  };

  return {
    put: ({ path, data, checksum }: { path: string; data: Blob; checksum: string }) =>
      request("PUT", path, {
        body: data,
        headers: { Checksum: checksum.toUpperCase() },
        signal: AbortSignal.timeout(
          REQUEST_TIMEOUT_MS + Math.ceil(data.size / MIN_UPLOAD_BYTES_PER_MS),
        ),
      }),
    delete: (path: string) =>
      request("DELETE", path, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
    async list() {
      const files = new Map<string, string>();
      let dirs = [""];

      while (dirs.length) {
        const subdirs: string[] = [];
        await pool(dirs, 8, async (dir) => {
          const response = await request("GET", dir, {
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
          const entries = parseResponse(
            Listing,
            await response.json().catch(() => undefined),
            `GET /${dir}`,
          );

          for (const entry of entries) {
            const path = dir + entry.ObjectName;
            if (entry.IsDirectory) subdirs.push(`${path}/`);
            else files.set(path, entry.Checksum ?? "");
          }
        });
        dirs = subdirs;
      }

      return files;
    },
  };
}

function parseResponse<T>(schema: z.ZodMiniType<T>, json: unknown, request: string) {
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new Error(
      `bunny.net returned an unexpected response for ${request}: ${issues(result.error).join("; ")}`,
    );
  }

  return result.data;
}

async function errorText(response: Response) {
  const text = await response.text().catch(() => "");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }

  const body = ErrorBody.safeParse(json);
  if (body.success) return `${body.data.Message} (HTTP ${response.status})`;

  return `${text.slice(0, 200) || "no details"} (HTTP ${response.status})`;
}

export async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<unknown>) {
  let next = 0;
  let failed = false;

  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (!failed && next < items.length) {
        await fn(items[next++]).catch((error: unknown) => {
          failed = true;
          throw error;
        });
      }
    }),
  );
}

export function checkRuleLimit(pullZone: PullZone, rules: EdgeRule[]) {
  const unmanaged = pullZone.EdgeRules.filter((r) => !isManaged(r));
  const managed = new Set(rules.map((r) => r.Description)).size;
  // bunny.net rejects every edge rule write on a full zone, updates included
  if (managed + unmanaged.length < MAX_EDGE_RULES) return;

  throw new Error(
    `This deploy needs ${managed + unmanaged.length} edge rules (${managed} from orbitpush, ${unmanaged.length} others on the pull zone). bunny.net allows ${MAX_EDGE_RULES} edge rules per pull zone and accepts no change to a full one, so a deploy can use ${MAX_EDGE_RULES - 1}. Remove entries from redirects or headers in orbitpush.json, or ask bunny.net support to raise the limit.`,
  );
}

export async function syncRules(apiKey: string, pullZone: PullZone, rules: EdgeRule[]) {
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
