import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { Config } from "../src/config.ts";
import { destroy } from "../src/commands/destroy.ts";

const cwd = process.cwd();

const config: Config = {
  name: "site",
  outputDir: "dist",
  aliases: [],
  region: "DE",
  replicationRegions: [],
  geoZones: ["EU"],
  redirects: [],
  headers: [],
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

function fakeBunny({
  status = {},
  pullZone = { Id: 2, Name: "site", OriginType: 2, StorageZoneId: 7, Hostnames: [], EdgeRules: [] },
}: { status?: Record<string, number>; pullZone?: Record<string, unknown> } = {}) {
  const requests: string[] = [];

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = input instanceof Request ? input.url : input.toString();
    const request = `${init.method ?? "GET"} ${url}`;

    requests.push(request);
    if (status[request]) return new Response(null, { status: status[request] });
    if (request === getPullZone) return new Response(JSON.stringify(pullZone));

    return new Response(null, { status: 204 });
  });

  return { requests };
}

const getPullZone = "GET https://api.bunny.net/pullzone/2";
const deleteStorageZone = "DELETE https://api.bunny.net/storagezone/7";
const deletePullZone = "DELETE https://api.bunny.net/pullzone/2";
const deletes = (requests: string[]) => requests.filter((r) => r.startsWith("DELETE "));

test("destroy without --yes outside a terminal sends nothing and keeps orbitpush.json", async () => {
  const { requests } = fakeBunny();

  await expect(destroy("key", config, { interactive: false })).rejects.toThrow(/--yes/);
  expect(requests).toEqual([]);
  expect(existsSync("orbitpush.json")).toBe(true);
});

test("destroy deletes the storage zone the pull zone names, then the pull zone, then orbitpush.json", async () => {
  const { requests } = fakeBunny();

  await destroy("key", config, { yes: true, interactive: false });

  expect(requests).toEqual([getPullZone, deleteStorageZone, deletePullZone]);
  expect(existsSync("orbitpush.json")).toBe(false);
});

test("destroy counts a pull zone that bunny.net deleted with its storage zone as deleted", async () => {
  const { requests } = fakeBunny({ status: { [deletePullZone]: 404 } });

  await destroy("key", config, { yes: true, interactive: false });

  expect(deletes(requests)).toEqual([deleteStorageZone, deletePullZone]);
  expect(existsSync("orbitpush.json")).toBe(false);
});

test("destroy counts a storage zone that is already gone as deleted", async () => {
  const { requests } = fakeBunny({ status: { [deleteStorageZone]: 404 } });

  await destroy("key", config, { yes: true, interactive: false });

  expect(deletes(requests)).toEqual([deleteStorageZone, deletePullZone]);
  expect(existsSync("orbitpush.json")).toBe(false);
});

test("destroy rerun after both zones are gone sends no delete, removes orbitpush.json and names the storage zone to check", async () => {
  const { requests } = fakeBunny({ status: { [getPullZone]: 404 } });

  await destroy("key", config, { yes: true, interactive: false });

  expect(requests).toEqual([getPullZone]);
  expect(existsSync("orbitpush.json")).toBe(false);
  expect(stderr()).toMatch(/storage zone named site is left/);
  expect(stderr()).not.toMatch(/Deleted site from bunny.net/);
});

test("destroy does not warn about a leftover storage zone when it deleted it", async () => {
  fakeBunny();

  await destroy("key", config, { yes: true, interactive: false });

  expect(stderr()).not.toMatch(/is left/);
  expect(stderr()).toMatch(/Deleted site/);
});

function stderr() {
  return vi
    .mocked(process.stderr.write)
    .mock.calls.map(([chunk]) => String(chunk))
    .join("");
}

test("destroy stops and keeps orbitpush.json when the pull zone cannot be read", async () => {
  const { requests } = fakeBunny({ status: { [getPullZone]: 500 } });

  await expect(destroy("key", config, { yes: true, interactive: false })).rejects.toMatchObject({
    status: 500,
  });
  expect(deletes(requests)).toEqual([]);
  expect(existsSync("orbitpush.json")).toBe(true);
});

test("destroy keeps the pull zone and orbitpush.json when the storage zone delete fails", async () => {
  const { requests } = fakeBunny({ status: { [deleteStorageZone]: 500 } });

  await expect(destroy("key", config, { yes: true, interactive: false })).rejects.toMatchObject({
    status: 500,
  });
  expect(deletes(requests)).toEqual([deleteStorageZone]);
  expect(existsSync("orbitpush.json")).toBe(true);
});

test("destroy deletes nothing when the pull zone has no storage zone origin", async () => {
  const { requests } = fakeBunny({
    pullZone: {
      Id: 2,
      Name: "site",
      OriginType: 0,
      StorageZoneId: 0,
      Hostnames: [],
      EdgeRules: [],
    },
  });

  await expect(destroy("key", config, { yes: true, interactive: false })).rejects.toThrow();
  expect(deletes(requests)).toEqual([]);
  expect(existsSync("orbitpush.json")).toBe(true);
});

test("destroy deletes nothing when the pull zone's storage zone is null", async () => {
  const { requests } = fakeBunny({
    pullZone: {
      Id: 2,
      Name: "site",
      OriginType: 0,
      StorageZoneId: null,
      Hostnames: [],
      EdgeRules: [],
    },
  });

  await expect(destroy("key", config, { yes: true, interactive: false })).rejects.toThrow();
  expect(deletes(requests)).toEqual([]);
  expect(existsSync("orbitpush.json")).toBe(true);
});
