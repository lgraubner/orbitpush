import { expect, test as setup } from "@playwright/test";

import { sites, untilStatus } from "./site.ts";

for (const s of Object.values(sites)) {
  setup(`init and deploy ${s.name}`, async () => {
    const prepared = await s.init();
    expect(prepared.code).toBe(0);
    if (s === sites.multiPage) {
      expect(prepared.stderr).toContain("netlify.toml headers.0.values.Basic-Auth not migrated");
      expect(prepared.stderr).not.toContain("e2e-secret");
    }

    const deploy = await s.cli("deploy");
    expect(deploy.code).toBe(0);
    if (s === sites.multiPage) {
      expect(deploy.stderr).toContain("redirects.3 status 308 is sent as 301");
      expect(deploy.stderr).toContain("redirects.5 skipped");
      expect(deploy.stderr).toContain("redirects.8 status 307 is sent as 302");
      expect(deploy.stderr).toContain("_redirects is not read");
      expect(deploy.stderr).not.toContain("e2e-secret");
      expect(deploy.stderr).toContain("headers.6.values.Content-Length skipped (not supported)");
      expect(deploy.stderr).toContain("headers.6.values.Server skipped (not supported)");
    }

    // Edge rules go live one by one, so wait for the trailing slash rule, which is written last
    const deployed = Date.now();
    await untilStatus(s, `${s.cdnUrl}${s.ready.path}`, s.ready.status);
    process.stdout.write(`${s.name}: last edge rule live after ${Date.now() - deployed} ms\n`);
  });
}
