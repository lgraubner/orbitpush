import { execFile } from "node:child_process";
import { lookup } from "node:dns";
import { existsSync } from "node:fs";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "@playwright/test";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const SITES = new URL("sites/", import.meta.url).pathname;
const DOMAIN = process.env.E2E_DOMAIN ?? "e2e.dev.larsgraubner.de";

export type Response = { status: number; headers: IncomingHttpHeaders; body: string };

function site(
  demo: string,
  { domain = false, ready }: { domain?: boolean; ready: { path: string; status: number } },
) {
  const name = `orbitpush-e2e-${demo}-${process.env.E2E_RUN}`;
  const cdnHost = `${name}.b-cdn.net`;
  const customDomain = domain ? `${demo}-${process.env.E2E_RUN}.${DOMAIN}` : undefined;
  const alias = customDomain && `www.${customDomain}`;
  const dir = join(tmpdir(), `orbitpush-e2e-${process.env.E2E_RUN}`, demo);

  const cli = (...args: string[]) =>
    new Promise<{ code: number; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        [CLI, ...args],
        { cwd: dir, env: { ...process.env, CI: "1" } },
        (error, _stdout, stderr) => resolve({ code: error ? Number(error.code ?? 1) : 0, stderr }),
      );
    });

  // The custom hostnames have no DNS records, so every request connects to the
  // pull zone and sends the custom hostname as Host and SNI. Their certificate
  // is never issued, so TLS is only verified on b-cdn.net.
  const get = (url: string, method = "GET") =>
    new Promise<Response>((resolve, reject) => {
      const { hostname, protocol } = new URL(url);
      const request = protocol === "http:" ? httpRequest : httpsRequest;
      request(
        url,
        {
          method,
          rejectUnauthorized: hostname === cdnHost,
          lookup: (_host, options, callback) => lookup(cdnHost, options, callback),
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        },
      )
        .on("error", reject)
        .end();
    });

  const status = (url: string) =>
    get(url).then(
      (r) => r.status,
      () => 0,
    );

  return {
    name,
    cdnUrl: `https://${cdnHost}`,
    domainUrl: customDomain && `https://${customDomain}`,
    aliasUrl: alias && `https://${alias}`,
    dir,
    ready,
    cli,
    get,
    status,

    async init() {
      if (!process.env.BUNNY_API_KEY) throw new Error("Set BUNNY_API_KEY to run the e2e suite.");

      await rm(dir, { recursive: true, force: true });
      await cp(join(SITES, demo), join(dir, "public"), { recursive: true });
      const domainFlags = customDomain ? ["--domain", customDomain, "--alias", alias ?? ""] : [];
      const result = await cli("init", "--name", name, "--dir", "public", ...domainFlags, "--yes");
      if (result.code !== 0) return result;

      const extra = join(SITES, `${demo}.orbitpush.json`);
      if (!existsSync(extra)) return result;

      const text = (await readFile(extra, "utf8"))
        .replaceAll("{{domain}}", customDomain ?? "")
        .replaceAll("{{country}}", process.env.E2E_COUNTRY ?? "aq");
      const file = join(dir, "orbitpush.json");
      await writeFile(
        file,
        JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), ...JSON.parse(text) }),
      );
      return result;
    },

    async cleanup() {
      if (existsSync(join(dir, "orbitpush.json"))) await cli("destroy", "--yes");
    },
  };
}

export type Site = ReturnType<typeof site>;

export const sites = {
  singleFile: site("single-file", { ready: { path: "/guides", status: 301 } }),
  multiPage: site("multi-page", { domain: true, ready: { path: "/guides", status: 301 } }),
  spa: site("spa", { ready: { path: "/projects/alpha/", status: 301 } }),
};

export const untilStatus = (s: Site, url: string, expected: number) =>
  expect.poll(() => s.status(url), { timeout: 120_000, intervals: [2_000] }).toBe(expected);
