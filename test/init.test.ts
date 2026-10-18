import { chmod, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { init } from "../src/init.ts";

const cwd = process.cwd();
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbitpush-init-"));
  process.chdir(dir);
  vi.stubEnv("BUNNY_API_KEY", "key");
});

afterEach(async () => {
  process.chdir(cwd);
  await chmod(dir, 0o755);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function fakeBunny({ pullZoneTaken = false } = {}) {
  const writes: string[] = [];

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = input instanceof Request ? input.url : input.toString();
    const method = init.method ?? "GET";
    const json = (value: unknown) => new Response(JSON.stringify(value));

    if (method !== "GET") writes.push(`${method} ${url}`);
    if (url === "https://api.bunny.net/storagezone" && method === "POST") return json({ Id: 1 });
    if (url === "https://api.bunny.net/pullzone" && method === "POST") {
      return pullZoneTaken
        ? new Response(JSON.stringify({ Message: "name taken" }), { status: 400 })
        : json({ Id: 2 });
    }

    if (url === "https://api.bunny.net/pullzone/2") {
      return json({ Id: 2, Name: "site", Hostnames: [], EdgeRules: [] });
    }

    return new Response(null, { status: 204 });
  });

  return writes;
}

test("init creates both zones and writes orbitpush.json", async () => {
  const writes = fakeBunny();

  await init({ name: "site", yes: true }, false);

  expect(writes).toEqual([
    "POST https://api.bunny.net/storagezone",
    "POST https://api.bunny.net/pullzone",
  ]);
  const written: unknown = JSON.parse(await readFile("orbitpush.json", "utf8"));

  expect(written).toMatchObject({
    storageZoneId: 1,
    pullZoneId: 2,
  });
});

test("init deletes both zones when orbitpush.json cannot be written", async () => {
  const writes = fakeBunny();
  await chmod(dir, 0o555);

  await expect(init({ name: "site", yes: true }, false)).rejects.toMatchObject({ code: "EACCES" });
  expect(writes).toEqual([
    "POST https://api.bunny.net/storagezone",
    "POST https://api.bunny.net/pullzone",
    "DELETE https://api.bunny.net/pullzone/2",
    "DELETE https://api.bunny.net/storagezone/1",
  ]);
});

test("init deletes the storage zone when the pull zone cannot be created", async () => {
  const writes = fakeBunny({ pullZoneTaken: true });

  await expect(init({ name: "site", yes: true }, false)).rejects.toThrow();
  expect(writes).toEqual([
    "POST https://api.bunny.net/storagezone",
    "POST https://api.bunny.net/pullzone",
    "DELETE https://api.bunny.net/storagezone/1",
  ]);
});
