import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const REGION_HOSTS = {
  DE: "storage.bunnycdn.com",
  UK: "uk.storage.bunnycdn.com",
  SE: "se.storage.bunnycdn.com",
  NY: "ny.storage.bunnycdn.com",
  LA: "la.storage.bunnycdn.com",
  SG: "sg.storage.bunnycdn.com",
  SYD: "syd.storage.bunnycdn.com",
  BR: "br.storage.bunnycdn.com",
  JH: "jh.storage.bunnycdn.com",
};

const emptyState = () => ({ nextId: 1000, storageZones: [], pullZones: [], requests: [] });

function load(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : emptyState();
}

if (process.argv[2] === "summary") {
  const state = load(process.argv[3]);
  const summary = {
    storageZones: state.storageZones.map(({ Password: _password, ...zone }) => ({
      ...zone,
      files: Object.keys(zone.files ?? {}).sort(),
    })),
    pullZones: state.pullZones.map((zone) => ({
      ...zone,
      EdgeRules: zone.EdgeRules.map((rule) => ({
        Description: rule.Description,
        ActionType: rule.ActionType,
        ActionParameter1: rule.ActionParameter1,
        ActionParameter2: rule.ActionParameter2,
        OrderIndex: rule.OrderIndex,
        Pattern: rule.Triggers?.[0]?.PatternMatches?.[0],
        ExtraActions: rule.ExtraActions?.length ?? 0,
      })),
    })),
    writes: state.requests
      .filter((r) => r.method !== "GET")
      .map((r) => `${r.status} ${r.method} ${r.url}`),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} else {
  installFetch();
}

function installFetch() {
  const statePath = process.env.FAKE_BUNNY_STATE;
  if (!statePath) throw new Error("fake-bunny: set FAKE_BUNNY_STATE to a state file path");

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const body = await readBody(init.body);
    const state = load(statePath);

    let response;
    try {
      response = route(state, url, method, headers, body);
    } catch (error) {
      if (error instanceof Offline) throw error;
      response = reply(500, { Message: String(error) });
    }

    if (process.env.FAKE_BUNNY_FAIL === `${method} ${url.pathname}`) {
      response = reply(500, { Message: "fake-bunny: injected failure" });
    }

    state.requests.push({
      method,
      url: url.href,
      status: response.status,
      body:
        headers.get("content-type") === "application/json"
          ? JSON.parse(body.toString())
          : undefined,
    });
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

    return new Response(response.body === undefined ? null : JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  };
}

class Offline extends Error {}

async function readBody(body) {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  return Buffer.from(body);
}

const reply = (status, body) => ({ status, body });

function route(state, url, method, headers, body) {
  if (url.hostname === "api.bunny.net") return api(state, url, method, headers, body);
  if (url.hostname.endsWith("storage.bunnycdn.com"))
    return storage(state, url, method, headers, body);
  throw new Offline(`fake-bunny: blocked network request to ${url.href}`);
}

function api(state, url, method, headers, body) {
  if (!headers.get("AccessKey")) return reply(401, { Message: "Missing AccessKey" });

  const json = body.length ? JSON.parse(body.toString()) : {};
  const parts = url.pathname.split("/").filter(Boolean);
  const [kind, id, action, guid] = parts;

  if (kind === "storagezone") {
    if (!id && method === "POST") {
      if (state.storageZones.some((z) => z.Name === json.Name)) {
        return reply(400, { Message: "The storage zone name is already taken" });
      }

      const zone = {
        Id: state.nextId++,
        Name: json.Name,
        Region: json.Region,
        ReplicationRegions: json.ReplicationRegions ?? [],
        Password: randomUUID(),
        StorageHostname: REGION_HOSTS[json.Region] ?? "storage.bunnycdn.com",
        Custom404FilePath: null,
        Rewrite404To200: false,
        files: {},
      };
      state.storageZones.push(zone);
      return reply(201, publicZone(zone));
    }

    const zone = state.storageZones.find((z) => z.Id === Number(id));
    if (!zone) return reply(404, { Message: "Storage zone not found" });
    if (method === "GET") return reply(200, publicZone(zone));
    if (method === "POST") {
      Object.assign(zone, json);
      return reply(204);
    }

    if (method === "DELETE") {
      state.storageZones = state.storageZones.filter((z) => z !== zone);
      return reply(204);
    }
  }

  if (kind === "pullzone") {
    if (!id && method === "POST") {
      if (state.pullZones.some((z) => z.Name === json.Name)) {
        return reply(400, { Message: "The pull zone name is already taken" });
      }

      const zone = {
        ...json,
        Id: state.nextId++,
        Hostnames: [{ Value: `${json.Name}.b-cdn.net`, HasCertificate: true, ForceSSL: false }],
        EdgeRules: [],
        purges: 0,
      };
      state.pullZones.push(zone);
      return reply(201, zone);
    }

    if (id === "loadFreeCertificate") {
      const hostname = url.searchParams.get("hostname");
      const zone = state.pullZones.find((z) => z.Hostnames.some((h) => h.Value === hostname));
      if (!zone || process.env.FAKE_BUNNY_CERT !== "ok") {
        return reply(400, { Message: `DNS for ${hostname} does not point to the pull zone` });
      }

      zone.Hostnames.find((h) => h.Value === hostname).HasCertificate = true;
      return reply(200);
    }

    const zone = state.pullZones.find((z) => z.Id === Number(id));
    if (!zone) return reply(404, { Message: "Pull zone not found" });

    if (!action) {
      if (method === "GET") return reply(200, zone);
      if (method === "POST") {
        Object.assign(zone, json);
        return reply(200, zone);
      }

      if (method === "DELETE") {
        state.pullZones = state.pullZones.filter((z) => z !== zone);
        return reply(204);
      }
    }

    if (action === "addHostname" && method === "POST") {
      zone.Hostnames.push({ Value: json.Hostname, HasCertificate: false, ForceSSL: false });
      return reply(204);
    }

    if (action === "setForceSSL" && method === "POST") {
      zone.Hostnames.find((h) => h.Value === json.Hostname).ForceSSL = json.ForceSSL;
      return reply(204);
    }

    if (action === "edgerules" && guid === "addOrUpdate" && method === "POST") {
      // bunny.net updates the rule with a known Guid in place and defaults OrderIndex to 0
      const rule = { OrderIndex: 0, ...json, Guid: json.Guid ?? randomUUID() };
      const index = zone.EdgeRules.findIndex((r) => r.Guid === rule.Guid);
      if (index === -1) zone.EdgeRules.push(rule);
      else zone.EdgeRules[index] = rule;
      return reply(201);
    }

    if (action === "edgerules" && method === "DELETE") {
      zone.EdgeRules = zone.EdgeRules.filter((r) => r.Guid !== guid);
      return reply(204);
    }

    if (action === "purgeCache" && method === "POST") {
      zone.purges++;
      return reply(204);
    }
  }

  return reply(404, { Message: `fake-bunny: no route for ${method} ${url.pathname}` });
}

function publicZone({ files: _files, ...zone }) {
  return zone;
}

function storage(state, url, method, headers, body) {
  const [zoneName, ...rest] = url.pathname.split("/").slice(1).map(decodeURIComponent);
  const zone = state.storageZones.find((z) => z.Name === zoneName);
  if (!zone || REGION_HOSTS[zone.Region] !== url.hostname)
    return reply(401, { Message: "Unauthorized" });
  if (headers.get("AccessKey") !== zone.Password) return reply(401, { Message: "Unauthorized" });

  const path = rest.join("/");

  if (method === "PUT") {
    const checksum = createHash("sha256").update(body).digest("hex").toUpperCase();
    if (headers.get("Checksum") && headers.get("Checksum") !== checksum) {
      return reply(400, { Message: "Checksum mismatch" });
    }

    zone.files[path] = { Checksum: checksum, Length: body.length };
    return reply(201);
  }

  if (method === "DELETE") {
    for (const file of Object.keys(zone.files)) {
      if (file === path || file.startsWith(`${path}/`)) delete zone.files[file];
    }

    return reply(200);
  }

  if (method === "GET" && (path === "" || path.endsWith("/"))) {
    const entries = new Map();
    for (const [file, meta] of Object.entries(zone.files)) {
      if (!file.startsWith(path)) continue;
      const [name, ...deeper] = file.slice(path.length).split("/");
      entries.set(
        name,
        deeper.length
          ? { ObjectName: name, IsDirectory: true, Checksum: null }
          : { ObjectName: name, IsDirectory: false, Checksum: meta.Checksum, Length: meta.Length },
      );
    }

    return reply(200, [...entries.values()]);
  }

  return reply(404, { Message: "Object not found" });
}
