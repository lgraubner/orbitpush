#!/usr/bin/env node
import { createRequire } from "node:module";

import { parseArgs } from "./args.ts";
import { apiKeyFromEnv } from "./bunny.ts";
import { readConfig } from "./config.ts";
import { deploy } from "./deploy.ts";
import { init } from "./init.ts";
import { errorMessage, log } from "./log.ts";
import { z } from "./zod.ts";

const { version } = z
  .object({ version: z.string() })
  .parse(createRequire(import.meta.url)("../package.json"));

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

const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY) && !process.env.CI;

try {
  const args = parseArgs(process.argv.slice(2));

  if (args.version) {
    process.stdout.write(`${version}\n`);
  } else if (args.help || !args.command) {
    process.stdout.write(`${help}\n`);
  } else if (args.command === "init") {
    await init(args.flags, interactive);
  } else if (args.command === "deploy") {
    const started = Date.now();
    await deploy(apiKeyFromEnv(), await readConfig());
    log.success(`Deployed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } else {
    process.stderr.write(`${help}\n`);
    process.exitCode = 2;
  }
} catch (error) {
  if (error instanceof Error && error.name === "ExitPromptError") {
    process.exitCode = 130;
  } else {
    log.error(errorMessage(error));
    process.exitCode = 1;
  }
}
