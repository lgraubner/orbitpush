import { expect, test as setup } from "@playwright/test";

import { sites, untilStatus } from "./site.ts";

for (const s of Object.values(sites)) {
  setup(`init and deploy ${s.name}`, async () => {
    expect((await s.init()).code).toBe(0);

    const deploy = await s.cli("deploy");
    expect(deploy.code).toBe(0);
    if (s === sites.multiPage) {
      expect(deploy.stderr).toContain("_redirects:4 status 308 is sent as 301");
      expect(deploy.stderr).toContain("_redirects:8 skipped");
      expect(deploy.stderr).toContain("_redirects:11 status 307 is sent as 302");
      expect(deploy.stderr).toMatch(/_headers:\d+ skipped \(Basic-Auth/);
      expect(deploy.stderr).not.toContain("e2e-secret");
      expect(deploy.stderr).toContain("skipped (Content-Length is set by bunny.net)");
      expect(deploy.stderr).toContain("skipped (Server is set by bunny.net)");
    }

    // Edge rules go live one by one, so wait for the trailing slash rule, which is written last
    const deployed = Date.now();
    await untilStatus(s, `${s.cdnUrl}${s.ready.path}`, s.ready.status);
    process.stdout.write(`${s.name}: last edge rule live after ${Date.now() - deployed} ms\n`);
  });
}
