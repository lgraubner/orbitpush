import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { sites, untilStatus } from "./site.ts";

for (const s of Object.values(sites)) {
  test.describe.serial(s.name, () => {
    const hosts = [s.cdnUrl, s.domainUrl, s.aliasUrl].filter((url) => url !== undefined);

    test.afterAll(() => s.cleanup());

    if (s === sites.multiPage) {
      test("redeploy uploads changes, keeps removed files as stale, deletes removed rules, purges", async () => {
        const pub = join(s.dir, "public");
        const index = join(pub, "index.html");
        const html = await readFile(index, "utf8");
        await writeFile(index, html.replace("</body>", "<p>redeployed</p></body>"));
        await rm(join(pub, "contact.html"));
        const config = join(s.dir, "orbitpush.json");
        const json: object = JSON.parse(await readFile(config, "utf8"));
        await writeFile(config, JSON.stringify({ ...json, headers: [] }));

        const result = await s.cli("deploy");
        expect(result.code).toBe(0);
        expect(result.stderr).toMatch(/Files: .*1 kept/);
        expect(await s.status(`${s.cdnUrl}/contact.html`)).toBe(200);
        const record: unknown = JSON.parse((await s.get(`${s.cdnUrl}/.orbitpush/stale.json`)).body);
        expect(record).toMatchObject({ version: 1, stale: { "contact.html": expect.any(String) } });

        await expect
          .poll(async () => (await s.get(`${s.cdnUrl}/`)).headers["x-e2e-block"], {
            timeout: 120_000,
            intervals: [2_000],
          })
          .toBeUndefined();
        expect((await s.get(`${s.cdnUrl}/`)).body).toContain("<p>redeployed</p>");
      });
    }

    test("disable blocks every hostname", async () => {
      expect((await s.cli("disable")).code).toBe(0);
      for (const url of hosts) await untilStatus(s, `${url}/`, 403);

      const again = await s.cli("disable");
      expect(again.code).toBe(0);
      expect(again.stderr).toContain("already disabled");
    });

    test("deploy while disabled keeps the block", async () => {
      const result = await s.cli("deploy");
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("disabled");
      expect(await s.status(`${s.cdnUrl}/`)).toBe(403);
    });

    test("enable serves every hostname again", async () => {
      expect((await s.cli("enable")).code).toBe(0);
      for (const url of hosts) await untilStatus(s, `${url}/`, url === s.aliasUrl ? 301 : 200);
    });

    test("destroy needs --yes, then deletes both zones", async () => {
      const config = JSON.parse(await readFile(join(s.dir, "orbitpush.json"), "utf8")) as {
        pullZoneId: number;
      };
      const headers = { AccessKey: process.env.BUNNY_API_KEY ?? "" };
      const pullZoneResponse = await fetch(`https://api.bunny.net/pullzone/${config.pullZoneId}`, {
        headers,
      });
      expect(pullZoneResponse.status).toBe(200);
      const pullZone = (await pullZoneResponse.json()) as { StorageZoneId: unknown };
      expect(pullZone.StorageZoneId).toEqual(expect.any(Number));

      expect((await s.cli("destroy")).code).toBe(1);
      expect(existsSync(join(s.dir, "orbitpush.json"))).toBe(true);

      expect((await s.cli("destroy", "--yes")).code).toBe(0);
      expect(existsSync(join(s.dir, "orbitpush.json"))).toBe(false);

      for (const path of [
        `pullzone/${config.pullZoneId}`,
        `storagezone/${pullZone.StorageZoneId}`,
      ]) {
        const response = await fetch(`https://api.bunny.net/${path}`, { headers });
        expect(response.status, path).toBe(404);
      }
    });
  });
}
