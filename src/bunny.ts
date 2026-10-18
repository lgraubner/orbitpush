import { GEO_ZONES, type GeoZone } from "./config.ts";
import { log } from "./log.ts";
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

export function getPullZone(apiKey: string, pullZoneId: number) {
  return apiJson(apiKey, { schema: PullZone, method: "GET", path: `/pullzone/${pullZoneId}` });
}

export async function purgeCache(apiKey: string, pullZoneId: number) {
  log.step("Purging cache");
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
    init: { body?: Blob; headers?: Record<string, string> } = {},
  ) => {
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(url(path), {
        ...init,
        method,
        headers: { AccessKey: zone.Password, ...init.headers },
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
      request("PUT", path, { body: data, headers: { Checksum: checksum.toUpperCase() } }),
    delete: (path: string) => request("DELETE", path),
    async list() {
      const files = new Map<string, string>();
      let dirs = [""];

      while (dirs.length) {
        const subdirs: string[] = [];
        await pool(dirs, 8, async (dir) => {
          const response = await request("GET", dir);
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

  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}
