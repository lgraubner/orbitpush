import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

function inTerminal(cwd: string, env: NodeJS.ProcessEnv, command: string) {
  // BSD script(1) rejects a socket as stdin, so cat turns Node's stdin socket into a pipe.
  // The util-linux script takes the command as one string, the BSD script as arguments.
  const pty =
    process.platform === "linux"
      ? `${script} -qec "${command}" /dev/null`
      : `${script} -q /dev/null /bin/sh -c "${command}"`;

  return spawn("/bin/sh", ["-c", `cat | ${pty}`], { cwd, env });
}

function offlineDir() {
  const cwd = mkdtempSync(join(tmpdir(), "orbitpush-cli-"));
  const offline = join(cwd, "offline.mjs");
  writeFileSync(offline, 'globalThis.fetch = () => { throw new Error("offline"); };');

  return { cwd, offline };
}

const quoted = (...args: string[]) => args.map((arg) => `'${arg}'`).join(" ");

test.skipIf(!script).each([
  ["unset", undefined],
  ["false", "false"],
])(
  "cancelling a prompt with Ctrl+C exits with 130, with CI %s",
  async (_, ci) => {
    const { cwd, offline } = offlineDir();
    const env: NodeJS.ProcessEnv = { ...process.env, BUNNY_API_KEY: "not-a-key", CI: ci };
    if (ci === undefined) delete env.CI;
    const child = inTerminal(
      cwd,
      env,
      quoted(process.execPath, "--import", offline, entry, "init"),
    );

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

test.skipIf(!script)(
  "output redirected away from the terminal carries no color codes",
  async () => {
    const { cwd } = offlineDir();
    const env: NodeJS.ProcessEnv = { ...process.env, BUNNY_API_KEY: "not-a-key" };
    delete env.FORCE_COLOR;
    delete env.NO_COLOR;
    const child = inTerminal(cwd, env, `${quoted(process.execPath, entry, "deploy")} 2> err.txt`);
    child.stdin.end();

    await new Promise((resolve) => child.on("close", resolve));

    const stderr = readFileSync(join(cwd, "err.txt"), "utf8");
    expect(stderr).toMatch(/orbitpush\.json not found/);
    expect(stderr).not.toContain("\u001b[");
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

function answerFirstPrompt(child: ReturnType<typeof inTerminal>, keys: string) {
  let output = "";

  return new Promise<{ status: number | null; output: string }>((resolve) => {
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("?") && child.stdin.writable) child.stdin.end(keys);
    });
    child.on("close", (status) => resolve({ status, output }));
  });
}

test.skipIf(!script).each([
  ["declining", "n\r", 1],
  ["Ctrl+C", "\x03", 130],
])(
  "deploy without orbitpush.json in a terminal asks to set up a site, and %s creates nothing",
  async (_, keys, expected) => {
    const { cwd, offline } = offlineDir();
    const env: NodeJS.ProcessEnv = { ...process.env, BUNNY_API_KEY: "not-a-key" };
    delete env.CI;
    const child = inTerminal(
      cwd,
      env,
      quoted(process.execPath, "--import", offline, entry, "deploy"),
    );

    const { status, output } = await answerFirstPrompt(child, keys);

    expect(output).toMatch(/Set up a new site/);
    expect(status).toBe(expected);
    expect(existsSync(join(cwd, "orbitpush.json"))).toBe(false);
  },
  10_000,
);

test("deploy without orbitpush.json outside a terminal asks nothing and exits with 1", () => {
  const { cwd, offline } = offlineDir();
  const env = { ...process.env, BUNNY_API_KEY: "not-a-key", CI: "1" };

  const result = spawnSync(process.execPath, ["--import", offline, entry, "deploy"], {
    cwd,
    encoding: "utf8",
    env,
  });

  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/orbitpush\.json not found/);
  expect(result.stderr).not.toMatch(/Set up a new site/);
  expect(existsSync(join(cwd, "orbitpush.json"))).toBe(false);
});
