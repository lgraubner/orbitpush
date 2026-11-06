import { join } from "node:path";

import { parse as parseToml } from "smol-toml";

import { CONFIG_FILE, type Header, type Redirect, readConfig, writeConfig } from "@/config.ts";
import { readIfExists } from "@/files.ts";
import { errorMessage, log } from "@/log.ts";
import { headerRules, redirectRules } from "@/rules.ts";
import { issues, z } from "@/zod.ts";

const NETLIFY_TOML = "netlify.toml";

// netlify.toml fields orbitpush has no use for, such as `signed`, are dropped, not rejected
const NetlifyToml = z.looseObject({
  redirects: z._default(
    z.array(
      z.looseObject({
        from: z.string(),
        to: z.optional(z.string()),
        status: z.optional(z.int()),
        force: z.optional(z.boolean()),
        query: z.optional(z.record(z.string(), z.string())),
        conditions: z.optional(z.record(z.string(), z.array(z.string()))),
      }),
    ),
    [],
  ),
  headers: z._default(
    z.array(
      z.looseObject({
        for: z.string(),
        values: z._default(
          z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
          {},
        ),
      }),
    ),
    [],
  ),
});

type Migrated = { redirects: Redirect[]; headers: Header[]; warnings: string[] };

export async function migrateNetlify() {
  const config = await readConfig();
  if (config.redirects.length || config.headers.length) {
    throw new Error(
      `${CONFIG_FILE} already has redirects or headers. Empty both to migrate again.`,
    );
  }

  const redirectsFile = await readIfExists(join(config.outputDir, "_redirects"));
  const headersFile = await readIfExists(join(config.outputDir, "_headers"));
  const toml = await readIfExists(NETLIFY_TOML);
  if (redirectsFile === undefined && headersFile === undefined && toml === undefined) {
    throw new Error(
      `Nothing to migrate: no ${NETLIFY_TOML} here and no _redirects or _headers in ${config.outputDir}. If your build copies them there, build first.`,
    );
  }

  // Netlify applies the _redirects file before the redirects in netlify.toml
  const parts = [
    parseRedirectsFile(redirectsFile ?? ""),
    parseHeadersFile(headersFile ?? ""),
    parseNetlifyToml(toml ?? ""),
  ];
  const redirects = parts.flatMap((part) => part.redirects);
  const headers = parts.flatMap((part) => part.headers);
  for (const warning of parts.flatMap((part) => part.warnings)) log.warn(warning);

  await writeConfig({ ...config, redirects, headers }, { overwrite: true });
  log.success(
    `Wrote ${redirects.length} redirects and ${headers.length} headers entries to ${CONFIG_FILE}`,
  );

  const skipped = [...redirectRules(redirects).warnings, ...headerRules(headers).warnings];
  if (skipped.length) {
    log.step("Deploy will skip what bunny.net can't serve:");
    for (const warning of skipped) log.warn(warning);
  }
}

export function parseRedirectsFile(text: string): Migrated {
  const redirects: Redirect[] = [];
  const warnings: string[] = [];

  for (const [n, line] of lines(text)) {
    const skip = (why: string) => warnings.push(`_redirects:${n} not migrated (${why}): ${line}`);
    const [from, ...rest] = line.split(/\s+/);
    const query: Record<string, string> = {};
    while (rest[0] && /^[^/]*=/.test(rest[0])) {
      const [key, value] = splitOnce(rest.shift() ?? "", "=");
      query[key] = value;
    }

    const to = rest.shift();
    if (!to) {
      skip("missing target");
      continue;
    }

    const statusToken = /^\d+!?$/.test(rest[0] ?? "") ? rest.shift() : undefined;
    const conditions: Record<string, string[]> = {};
    const malformed = rest.find((token) => !/^[A-Za-z]+=[^=]+$/.test(token));
    if (malformed) {
      skip(`"${malformed}" is not a status or a Name=value condition`);
      continue;
    }

    for (const token of rest) {
      const [key, values] = splitOnce(token, "=");
      const listed = values.split(",").filter(Boolean);
      if (listed.length) conditions[key] = [...(conditions[key] ?? []), ...listed];
    }

    redirects.push({
      from,
      to,
      status: statusToken ? Number(statusToken.replace(/!$/, "")) : 301,
      ...(statusToken?.endsWith("!") && { force: true }),
      ...(Object.keys(query).length && { query }),
      ...(Object.keys(conditions).length && { conditions }),
    });
  }

  return { redirects, headers: [], warnings };
}

export function parseHeadersFile(text: string): Migrated {
  const headers: Header[] = [];
  const warnings: string[] = [];
  const blocks: { n: number; path: string; values: Map<string, [string, string[]]> }[] = [];

  for (const [n, line, indented] of lines(text)) {
    const [name, value] = splitOnce(line, ":").map((part) => part.trim());
    if (name.toLowerCase() === "basic-auth") {
      warnings.push(`_headers:${n} not migrated (Basic-Auth is not supported)`);
      continue;
    }

    if (!indented) {
      blocks.push({ n, path: line, values: new Map() });
      continue;
    }

    const block = blocks.at(-1);
    if (!block || !name || !line.includes(":")) {
      warnings.push(`_headers:${n} not migrated (expected "Name: value" below a path): ${line}`);
      continue;
    }

    const [first, values] = block.values.get(name.toLowerCase()) ?? [name, []];
    block.values.set(name.toLowerCase(), [first, [...values, value]]);
  }

  for (const { n, path, values } of blocks) {
    if (!values.size) {
      warnings.push(
        `_headers:${n} not migrated (no indented "Name: value" lines below it): ${path}`,
      );
      continue;
    }

    headers.push({
      for: path,
      values: Object.fromEntries([...values.values()].map(([name, all]) => [name, all.join(", ")])),
    });
  }

  return { redirects: [], headers, warnings };
}

export function parseNetlifyToml(text: string): Migrated {
  let toml: unknown;
  try {
    toml = parseToml(text);
  } catch (error) {
    throw new Error(`Invalid ${NETLIFY_TOML}: ${errorMessage(error)}`);
  }

  const result = NetlifyToml.safeParse(toml);
  if (!result.success) {
    throw new Error(`Invalid ${NETLIFY_TOML}:\n  ${issues(result.error).join("\n  ")}`);
  }

  const warnings: string[] = [];
  const redirects: Redirect[] = [];
  result.data.redirects.forEach(({ from, to, status = 301, force, query, conditions }, i) => {
    if (to === undefined) {
      warnings.push(`${NETLIFY_TOML} redirects.${i} not migrated (missing "to"): ${from}`);
      return;
    }

    const nonEmpty = Object.entries(conditions ?? {}).filter(([, values]) => values.length);
    redirects.push({
      from,
      to,
      status,
      ...(force !== undefined && { force }),
      ...(query && { query }),
      ...(nonEmpty.length && { conditions: Object.fromEntries(nonEmpty) }),
    });
  });

  const headers: Header[] = [];
  result.data.headers.forEach(({ for: path, values }, i) => {
    const kept = Object.entries(values).filter(([name]) => {
      if (name.toLowerCase() !== "basic-auth") return true;

      warnings.push(`${NETLIFY_TOML} headers.${i}.values.${name} not migrated (not supported)`);
      return false;
    });
    // Netlify collapses a multi-line value into one header value
    const oneLine = kept.map(([name, value]) => [
      name,
      String(value)
        .split("\n")
        .map((part) => part.trim())
        .filter(Boolean)
        .join(" "),
    ]);
    if (oneLine.length) headers.push({ for: path, values: Object.fromEntries(oneLine) });
  });

  return { redirects, headers, warnings };
}

function lines(text: string): [number, string, boolean][] {
  return text
    .split(/\r?\n/)
    .map((raw, i): [number, string, boolean] => [i + 1, raw.trim(), /^\s/.test(raw)])
    .filter(([, line]) => line && !line.startsWith("#"));
}

function splitOnce(text: string, separator: string): [string, string] {
  const index = text.indexOf(separator);
  return index < 0 ? [text, ""] : [text.slice(0, index), text.slice(index + 1)];
}
