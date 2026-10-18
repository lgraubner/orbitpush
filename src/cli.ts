#!/usr/bin/env node
import { createRequire } from "node:module";

import mri from "mri";

import { apiKeyFromEnv } from "./bunny.ts";
import { readConfig } from "./config.ts";
import { deploy } from "./deploy.ts";
import { init } from "./init.ts";
import { log } from "./log.ts";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const help = `Deploy static sites to your own bunny.net account.

Usage:
  orbitpush init     Create a storage zone + pull zone and write orbitpush.json
  orbitpush deploy   Upload the build output, sync edge rules and purge the cache

Init options (skip the matching prompt):
  --name <name>      Storage zone and pull zone name
  --dir <path>       Build output directory
  --spa              Serve index.html for unknown paths
  --domain <host>    Custom domain, repeatable
  --region <code>    Main storage region (DE, UK, SE, NY, LA, SG, SYD, BR, JH)
  -y, --yes          Use defaults for everything else

Environment:
  BUNNY_API_KEY      Your bunny.net account API key (required)`;

const args = mri(process.argv.slice(2), {
  boolean: ["help", "version", "yes", "spa"],
  string: ["name", "dir", "domain", "region"],
  alias: { h: "help", v: "version", y: "yes" },
});
const [command] = args._;
const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY) && !process.env.CI;

try {
  if (args.version) process.stdout.write(`${version}\n`);
  else if (command === "init") {
    // mri defaults booleans to false; only skip the prompt when --spa or --no-spa was given.
    const spaGiven = process.argv.some((arg) => arg === "--spa" || arg === "--no-spa");
    await init({ ...args, spa: spaGiven ? args.spa : undefined }, interactive);
  } else if (command === "deploy") {
    const started = Date.now();
    await deploy(apiKeyFromEnv(), await readConfig());
    log.success(`Deployed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } else {
    process.stdout.write(`${help}\n`);
    if (command && !args.help) process.exitCode = 2;
  }
} catch (error) {
  if ((error as Error).name === "ExitPromptError") process.exitCode = 130;
  else {
    log.error((error as Error).message);
    process.exitCode = 1;
  }
}
