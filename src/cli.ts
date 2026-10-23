#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

import { parseArgs } from "./args.ts";
import { apiKeyFromEnv } from "./bunny.ts";
import { CONFIG_FILE, readConfig } from "./config.ts";
import { deploy } from "./deploy.ts";
import { destroy } from "./destroy.ts";
import { disable } from "./disable.ts";
import { domains } from "./domains.ts";
import { enable } from "./enable.ts";
import { init, setUpForDeploy } from "./init.ts";
import { errorMessage, log } from "./log.ts";
import { migrateNetlify } from "./migrate-netlify.ts";
import { z } from "./zod.ts";

const { version } = z
  .object({ version: z.string() })
  .parse(createRequire(import.meta.url)("../package.json"));

const help = `Deploy static sites to your own bunny.net account.

Usage:
  orbitpush init                   Create a storage zone + pull zone and write orbitpush.json
  orbitpush deploy                 Upload the build output, sync edge rules and purge the cache
  orbitpush domains add <host>     Add a domain and connect it: waits for its DNS record,
                                   then turns on HTTPS. The first one becomes the primary
                                   domain, later ones redirect to it
  orbitpush domains remove <host>  Remove a domain from orbitpush.json and the pull zone
  orbitpush domains list           Show each domain and what it still needs
  orbitpush disable                Block all requests to the site, keeping files and settings
  orbitpush enable                 Serve the site again after disable
  orbitpush destroy                Delete the pull zone, storage zone and orbitpush.json
  orbitpush migrate-netlify        Copy redirects and headers from netlify.toml, _redirects
                                   and _headers into orbitpush.json

Init options (skip the matching prompt):
  --name <name>                 Storage zone and pull zone name
  --dir <path>                  Build output directory
  --domain <host>               Primary domain
  --alias <host>                Hostname that redirects to the domain, repeatable
  --region <code>               Main storage region (DE, UK, SE, NY, LA, SG, SYD, BR, JH)
  --replication-region <code>   Extra storage region, repeatable (default: none)
  --delivery-region <zone>      CDN delivery region (EU, US, ASIA, SA, AF), repeatable (default: EU, US)
  -y, --yes                     Use defaults for everything else

Deploy options:
  --prune-hostnames             Remove hostnames from the pull zone that orbitpush.json does not list

Domains add options:
  --primary                     Make the domain the primary domain once it is connected

Destroy options:
  -y, --yes                     Delete without asking to type the project name

Environment:
  BUNNY_API_KEY                 Your bunny.net account API key (required)`;

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
    const setUp = interactive && !existsSync(CONFIG_FILE);
    const site = setUp
      ? await setUpForDeploy()
      : { apiKey: apiKeyFromEnv(), config: await readConfig() };
    const started = Date.now();
    const url = await deploy(site.apiKey, site.config, {
      pruneHostnames: args.flags["prune-hostnames"],
    });
    log.success(`Deployed to ${url} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    if (setUp) log.detail("Use your own domain: `npx orbitpush domains add www.example.com`");
  } else if (args.command === "domains") {
    const connected = await domains(apiKeyFromEnv(), await readConfig(), args.rest, {
      primary: args.flags.primary,
      interactive,
    });
    if (connected === false) process.exitCode = 1;
  } else if (args.command === "disable") {
    await disable(apiKeyFromEnv(), await readConfig());
  } else if (args.command === "enable") {
    await enable(apiKeyFromEnv(), await readConfig());
  } else if (args.command === "migrate-netlify") {
    await migrateNetlify();
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
