#!/usr/bin/env node
import { createRequire } from "node:module";

import { parseArgs } from "./args.ts";
import { apiKeyFromEnv } from "./bunny.ts";
import { readConfig } from "./config.ts";
import { deploy } from "./deploy.ts";
import { destroy } from "./destroy.ts";
import { disable } from "./disable.ts";
import { enable } from "./enable.ts";
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
  orbitpush disable  Block all requests to the site, keeping files and settings
  orbitpush enable   Serve the site again after disable
  orbitpush destroy  Delete the pull zone, storage zone and orbitpush.json

Init options (skip the matching prompt):
  --name <name>      Storage zone and pull zone name
  --dir <path>       Build output directory
  --domain <host>    Custom domain
  --alias <host>     Hostname that redirects to the domain, repeatable
  --region <code>    Main storage region (DE, UK, SE, NY, LA, SG, SYD, BR, JH)
  -y, --yes          Use defaults for everything else

Deploy options:
  --prune-hostnames  Remove hostnames from the pull zone that orbitpush.json does not list

Destroy options:
  -y, --yes          Delete without asking to type the project name

Environment:
  BUNNY_API_KEY      Your bunny.net account API key (required)`;

const ci = process.env.CI;
const interactive =
  Boolean(process.stdin.isTTY && process.stderr.isTTY) && (!ci || ci === "false" || ci === "0");

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
    await deploy(apiKeyFromEnv(), await readConfig(), {
      pruneHostnames: args.flags["prune-hostnames"],
    });
    log.success(`Deployed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } else if (args.command === "disable") {
    await disable(apiKeyFromEnv(), await readConfig());
  } else if (args.command === "enable") {
    await enable(apiKeyFromEnv(), await readConfig());
  } else if (args.command === "destroy") {
    await destroy(apiKeyFromEnv(), await readConfig(), { yes: args.flags.yes, interactive });
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
