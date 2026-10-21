import { afterEach, expect, test, vi } from "vitest";

import type { Config } from "../src/config.ts";
import { disable } from "../src/disable.ts";
import { enable } from "../src/enable.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

const config: Config = {
  name: "site",
  outputDir: "dist",
  aliases: [],
  region: "DE",
  replicationRegions: [],
  geoZones: ["EU"],
  redirects: [],
  headers: [],
  storageZoneId: 1,
  pullZoneId: 2,
};

function fakeBunny(edgeRules: { Guid: string; Description: string; OrderIndex: number }[]) {
  const writes: string[] = [];
  const bodies: Record<string, unknown> = {};

  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = input instanceof Request ? input.url : input.toString();
    const method = init.method ?? "GET";

    if (method !== "GET") writes.push(`${method} ${url}`);
    if (typeof init.body === "string") bodies[`${method} ${url}`] = JSON.parse(init.body);

    if (url === "https://api.bunny.net/pullzone/2" && method === "GET") {
      return new Response(
        JSON.stringify({ Id: 2, Name: "site", Hostnames: [], EdgeRules: edgeRules }),
      );
    }

    return new Response(null, { status: 204 });
  });

  return { writes, bodies };
}

// bunny.net reads a trigger pattern as a Lua pattern after "pattern:" and as a wildcard otherwise
function matches(pattern: string, url: string) {
  const source = pattern.startsWith("pattern:")
    ? pattern.slice("pattern:".length).replace(/%(.)/g, "\\$1")
    : `^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`;

  return new RegExp(source).test(url);
}

test("disable adds a rule that blocks every URL, then purges", async () => {
  const { writes, bodies } = fakeBunny([
    { Guid: "r", Description: "orbitpush 0000000000 /a /b 301", OrderIndex: 0 },
  ]);

  await disable("key", config);

  expect(writes).toEqual([
    "POST https://api.bunny.net/pullzone/2/edgerules/addOrUpdate",
    "POST https://api.bunny.net/pullzone/2/purgeCache",
  ]);
  const rule = bodies["POST https://api.bunny.net/pullzone/2/edgerules/addOrUpdate"] as {
    Triggers: { Type: number; PatternMatches: string[] }[];
  };
  expect(rule).toMatchObject({ Description: "orbitpush disabled", ActionType: 4, Enabled: true });
  expect(rule.Triggers).toHaveLength(1);
  expect(rule.Triggers[0].Type).toBe(0);
  for (const url of [
    "https://site.b-cdn.net/",
    "http://www.example.com/a/b.html?x=1",
    "https://example.com/assets/app.js",
  ]) {
    expect(rule.Triggers[0].PatternMatches.some((p) => matches(p, url))).toBe(true);
  }
});

test("disable on a disabled site sends no write", async () => {
  const { writes } = fakeBunny([{ Guid: "d", Description: "orbitpush disabled", OrderIndex: 0 }]);

  await disable("key", config);

  expect(writes).toEqual([]);
});

test("enable deletes every disabled rule and nothing else, then purges", async () => {
  const { writes } = fakeBunny([
    { Guid: "d1", Description: "orbitpush disabled", OrderIndex: 0 },
    { Guid: "managed", Description: "orbitpush 0000000000 /a /b 301", OrderIndex: 1 },
    { Guid: "near", Description: "orbitpush disabled later", OrderIndex: 2 },
    { Guid: "mine", Description: "created in dashboard", OrderIndex: 3 },
    { Guid: "d2", Description: "orbitpush disabled", OrderIndex: 4 },
  ]);

  await enable("key", config);

  expect(writes).toEqual([
    "DELETE https://api.bunny.net/pullzone/2/edgerules/d1",
    "DELETE https://api.bunny.net/pullzone/2/edgerules/d2",
    "POST https://api.bunny.net/pullzone/2/purgeCache",
  ]);
});

test("enable on a site that is not disabled sends no write", async () => {
  const { writes } = fakeBunny([
    { Guid: "managed", Description: "orbitpush 0000000000 /a /b 301", OrderIndex: 0 },
  ]);

  await enable("key", config);

  expect(writes).toEqual([]);
});
