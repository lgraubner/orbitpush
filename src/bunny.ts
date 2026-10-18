export const API_KEY_URL = "https://dash.bunny.net/account/api-key";

export type PullZone = {
  Id: number;
  Name: string;
  Hostnames: { Value: string; HasCertificate: boolean; ForceSSL: boolean }[];
  EdgeRules: { Guid: string; Description: string | null }[];
};

export type StorageZone = { Id: number; Name: string; Password: string; StorageHostname: string };

export function apiKeyFromEnv() {
  const key = process.env.BUNNY_API_KEY?.trim();
  if (!key) throw new Error(`BUNNY_API_KEY is not set. Create an API key at ${API_KEY_URL}`);
  return key;
}

export async function api<T = unknown>(
  apiKey: string,
  method: string,
  path: string,
  body?: unknown,
) {
  const response = await fetch(`https://api.bunny.net${path}`, {
    method,
    headers: {
      AccessKey: apiKey,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path} failed: ${await errorText(response)}`);
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export function storage(zone: StorageZone) {
  const base = `https://${zone.StorageHostname}/${encodeURIComponent(zone.Name)}/`;
  const url = (path: string) => base + path.split("/").map(encodeURIComponent).join("/");
  const request = async (
    method: string,
    path: string,
    init: { body?: Blob; headers?: Record<string, string> } = {},
  ) => {
    const response = await fetch(url(path), {
      ...init,
      method,
      headers: { AccessKey: zone.Password, ...init.headers },
    });
    if (!response.ok) throw new Error(`${method} /${path} failed: ${await errorText(response)}`);
    return response;
  };

  return {
    put: (path: string, data: Blob, checksum: string) =>
      request("PUT", path, { body: data, headers: { Checksum: checksum.toUpperCase() } }),
    delete: (path: string) => request("DELETE", path),
    async list(dir = ""): Promise<Map<string, string>> {
      const entries = (await (await request("GET", dir)).json()) as {
        ObjectName: string;
        IsDirectory: boolean;
        Checksum: string | null;
      }[];
      const files = new Map<string, string>();
      await Promise.all(
        entries.map(async (entry) => {
          const path = dir + entry.ObjectName;
          if (!entry.IsDirectory) files.set(path, entry.Checksum ?? "");
          else for (const [p, c] of await this.list(`${path}/`)) files.set(p, c);
        }),
      );
      return files;
    },
  };
}

async function errorText(response: Response) {
  const text = await response.text().catch(() => "");
  try {
    const json = JSON.parse(text) as { Message?: string };
    if (json.Message) return `${json.Message} (HTTP ${response.status})`;
  } catch {}
  return `${text.slice(0, 200) || "no details"} (HTTP ${response.status})`;
}
