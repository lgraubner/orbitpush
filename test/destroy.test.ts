import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { Config } from "../src/config.ts";
import { destroy } from "../src/destroy.ts";

const cwd = process.cwd();

const config: Config = {
  name: "site",
  outputDir: "dist",
  aliases: [],
  region: "DE",
  replicationRegions: [],
  geoZones: ["EU"],
  storageZoneId: 1,
  pullZoneId: 2,
};

beforeEach(async () => {
  process.chdir(await mkdtemp(join(tmpdir(), "orbitpush-destroy-")));
  await writeFile("orbitpush.json", JSON.stringify(config));
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  process.chdir(cwd);
  vi.restoreAllMocks();
});

function fakeBunny(status: Record<string, number> = {}) {
  const requests: string[] = [];

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = input instanceof Request ? input.url : input.toString();
    const request = `${init.method ?? "GET"} ${url}`;

    requests.push(request);

    return new Response(null, { status: status[request] ?? 204 });
  });

  return { requests };
}

const deletes = [
  "DELETE https://api.bunny.net/pullzone/2",
  "DELETE https://api.bunny.net/storagezone/1",
];

test("destroy without --yes outside a terminal sends nothing and keeps orbitpush.json", async () => {
  const { requests } = fakeBunny();

  await expect(destroy("key", config, { interactive: false })).rejects.toThrow(/--yes/);
  expect(requests).toEqual([]);
  expect(existsSync("orbitpush.json")).toBe(true);
});

test("destroy deletes the pull zone, then the storage zone, then orbitpush.json", async () => {
  const { requests } = fakeBunny();

  await destroy("key", config, { yes: true, interactive: false });

  expect(requests).toEqual(deletes);
  expect(existsSync("orbitpush.json")).toBe(false);
});

test("destroy treats zones that are already gone as deleted", async () => {
  const { requests } = fakeBunny({ [deletes[0]]: 404, [deletes[1]]: 404 });

  await destroy("key", config, { yes: true, interactive: false });

  expect(requests).toEqual(deletes);
  expect(existsSync("orbitpush.json")).toBe(false);
});

test("destroy stops when the pull zone delete fails", async () => {
  const { requests } = fakeBunny({ [deletes[0]]: 500 });

  await expect(destroy("key", config, { yes: true, interactive: false })).rejects.toMatchObject({
    status: 500,
  });
  expect(requests).toEqual([deletes[0]]);
  expect(existsSync("orbitpush.json")).toBe(true);
});
