import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test } from "vitest";

const entry = resolve("src/cli.ts");

function cli(...args: string[]) {
  const cwd = mkdtempSync(join(tmpdir(), "orbitpush-cli-"));
  const env = { ...process.env, BUNNY_API_KEY: "", CI: "1" };

  return spawnSync(process.execPath, [entry, ...args], { cwd, encoding: "utf8", env });
}

test.each([["deploy", "--help"], ["init", "-h"], ["--help"]])(
  "%s %s prints the help and runs nothing",
  (...args) => {
    const result = cli(...args);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^Deploy static sites/);
    expect(result.stderr).toBe("");
  },
);

test("an unknown command prints the help to stderr and exits with 2", () => {
  const result = cli("publish");

  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(/^Deploy static sites/);
});

test("a runtime error exits with 1", () => {
  const result = cli("deploy");

  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).not.toBe("");
});

// A prompt needs a TTY, so the CLI runs under script(1), which gives it a pseudo-terminal
const script = ["/usr/bin/script", "/bin/script"].find((path) => existsSync(path));

test.skipIf(!script)(
  "cancelling a prompt with Ctrl+C exits with 130",
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "orbitpush-cli-"));
    const offline = join(cwd, "offline.mjs");
    writeFileSync(offline, 'globalThis.fetch = () => { throw new Error("offline"); };');
    const env: NodeJS.ProcessEnv = { ...process.env, BUNNY_API_KEY: "not-a-key" };
    delete env.CI;
    const command = [process.execPath, "--import", offline, entry, "init"]
      .map((arg) => `'${arg}'`)
      .join(" ");
    // BSD script(1) rejects a socket as stdin, so cat turns Node's stdin socket into a pipe.
    // The util-linux script takes the command as one string, the BSD script as arguments.
    const pty =
      process.platform === "linux"
        ? `${script} -qec "${command}" /dev/null`
        : `${script} -q /dev/null ${command}`;
    const child = spawn("/bin/sh", ["-c", `cat | ${pty}`], { cwd, env });

    const status = await new Promise<number | null>((resolve) => {
      child.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("?") && child.stdin.writable) child.stdin.end("\x03");
      });
      child.on("close", resolve);
    });

    expect(status).toBe(130);
    expect(existsSync(join(cwd, "orbitpush.json"))).toBe(false);
  },
  10_000,
);

test("--help lists disable, enable and destroy", () => {
  const { stdout } = cli("--help");

  expect(stdout).toMatch(/orbitpush disable/);
  expect(stdout).toMatch(/orbitpush enable/);
  expect(stdout).toMatch(/orbitpush destroy/);
});

test("destroy without --yes outside a terminal exits with 1 and keeps orbitpush.json", () => {
  const cwd = mkdtempSync(join(tmpdir(), "orbitpush-cli-"));
  const offline = join(cwd, "offline.mjs");
  writeFileSync(offline, 'globalThis.fetch = () => { throw new Error("offline"); };');
  writeFileSync(
    join(cwd, "orbitpush.json"),
    JSON.stringify({
      name: "site",
      outputDir: "dist",
      spa: false,
      region: "DE",
      replicationRegions: [],
      geoZones: ["EU"],
      storageZoneId: 1,
      pullZoneId: 2,
    }),
  );
  const env = { ...process.env, BUNNY_API_KEY: "not-a-key", CI: "1" };

  const result = spawnSync(process.execPath, ["--import", offline, entry, "destroy"], {
    cwd,
    encoding: "utf8",
    env,
  });

  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/--yes/);
  expect(existsSync(join(cwd, "orbitpush.json"))).toBe(true);
});
