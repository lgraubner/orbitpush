import { createHash } from "node:crypto";

import { errorMessage } from "./log.ts";

// Bunny edge rule enums: https://docs.bunny.net/api-reference/core/pull-zone/addupdate-edge-rule
const REDIRECT = 1;
const BLOCK_REQUEST = 4;
const SET_RESPONSE_HEADER = 5;
const COUNTRY_CODE = 4;
const MATCH_ALL = 1;
const COUNTRY_CONDITION = /^Country=([a-z]{2}(?:,[a-z]{2})*)$/i;
// bunny.net serves only 301 and 302: it rejects 303 and serves 308 as 301
const SERVED_STATUS = new Map([
  [301, 301],
  [302, 302],
  [303, 302],
  [307, 302],
  [308, 301],
]);
export const RULE_PREFIX = "orbitpush ";
export const DISABLED_RULE = `${RULE_PREFIX}disabled`;

type EdgeRuleAction = { ActionType: number; ActionParameter1: string; ActionParameter2: string };

type Trigger = { Type: 0 | typeof COUNTRY_CODE; PatternMatchingType: 0; PatternMatches: string[] };

export type EdgeRule = EdgeRuleAction & {
  ExtraActions: EdgeRuleAction[];
  Triggers: Trigger[];
  TriggerMatchingType: 0 | typeof MATCH_ALL;
  Description: string;
  Enabled: true;
};

export type Parsed = { rules: EdgeRule[]; warnings: string[] };

// bunny.net matches edge rule triggers against the full request URL, scheme and host included
export function toPattern(from: string) {
  const match = /^(?:https?:\/\/([^/]+))?(\/.*)$/.exec(from);
  if (!match) throw new Error(`invalid path "${from}"`);

  const [, host, path] = match;
  const segments = path.split("/").slice(1);
  const params = new Map<string, number>();
  const parts = segments.map((segment, index) => {
    if (segment === "*") {
      if (index !== segments.length - 1) {
        throw new Error(`"*" must be the last segment in "${from}"`);
      }

      params.set("splat", index);
      return ".*";
    }

    if (segment.startsWith(":")) {
      params.set(segment.slice(1), index);
      return "[^/]+";
    }

    if (segment.includes("*")) throw new Error(`"*" must be a whole segment in "${from}"`);

    return segment.replace(/[\^$()%.[\]*+\-?]/g, "%$&");
  });

  let pattern = `/${parts.join("/")}`;
  // Netlify matches with and without trailing slash
  if (!pattern.endsWith(".*")) pattern = pattern.replace(/\/?$/, "/?");

  const hostPattern = host ? host.replace(/[\^$()%.[\]*+\-?]/g, "%$&") : "[^/]+";

  return { pattern: `pattern:^https?://${hostPattern}${pattern}$`, params };
}

function rule({
  description,
  pattern,
  conditions = [],
  actions: [first, ...extra],
}: {
  description: string;
  pattern: string;
  conditions?: Trigger[];
  actions: [EdgeRuleAction, ...EdgeRuleAction[]];
}): EdgeRule {
  const body = {
    ...first,
    ExtraActions: extra,
    Triggers: [{ Type: 0, PatternMatchingType: 0, PatternMatches: [pattern] }, ...conditions],
    TriggerMatchingType: conditions.length ? MATCH_ALL : 0,
    Enabled: true,
  } satisfies Omit<EdgeRule, "Description">;

  return { ...body, Description: `${RULE_PREFIX}${ruleHash(body)} ${description}`.slice(0, 255) };
}

function ruleHash(body: Omit<EdgeRule, "Description">) {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 10);
}

export function domainRules({
  name,
  domain,
  aliases,
}: {
  name: string;
  domain?: string;
  aliases: string[];
}): EdgeRule[] {
  if (!domain) return [];

  const main = domain.toLowerCase();

  const redirects = aliases.map((alias) =>
    rule({
      description: `alias ${alias.toLowerCase()} ${main}`,
      pattern: toPattern(`https://${alias.toLowerCase()}/*`).pattern,
      actions: [
        {
          ActionType: REDIRECT,
          ActionParameter1: `https://${main}%{Url.Path}`,
          ActionParameter2: "301",
        },
      ],
    }),
  );
  const noindex = rule({
    description: `noindex ${name}.b-cdn.net`,
    pattern: toPattern(`https://${name}.b-cdn.net/*`).pattern,
    actions: [
      {
        ActionType: SET_RESPONSE_HEADER,
        ActionParameter1: "X-Robots-Tag",
        ActionParameter2: "noindex",
      },
    ],
  });

  return [...redirects, noindex];
}

export function disabledRule(): EdgeRule {
  return {
    ActionType: BLOCK_REQUEST,
    ActionParameter1: "",
    ActionParameter2: "",
    ExtraActions: [],
    Triggers: [{ Type: 0, PatternMatchingType: 0, PatternMatches: [toPattern("/*").pattern] }],
    TriggerMatchingType: 0,
    Description: DISABLED_RULE,
    Enabled: true,
  };
}

export function parseRedirects(text: string): Parsed {
  const rules: EdgeRule[] = [];
  const warnings: string[] = [];

  lines(text).forEach(([n, line]) => {
    const skip = (why: string) => warnings.push(`_redirects:${n} skipped (${why}): ${line}`);
    const tokens = line.split(/\s+/);
    if (tokens.length < 2) return skip("missing target");

    const [from, to, ...rest] = tokens;
    if (/^[^/]*=/.test(to)) return skip("query parameter matching is not supported");

    const [statusToken, conditions] = /^\d/.test(rest[0] ?? "")
      ? [rest[0], rest.slice(1)]
      : ["301", rest];
    const unsupported = conditions.find((condition) => !COUNTRY_CONDITION.test(condition));
    if (unsupported) return skip(`condition "${unsupported}" is not supported`);

    const countries = [
      ...new Set(
        conditions.flatMap((condition) =>
          condition.slice("Country=".length).toUpperCase().split(","),
        ),
      ),
    ];

    const status = Number(statusToken.replace(/!$/, ""));
    if (status === 200 && from === "/*" && to === "/index.html") {
      return skip('set "spa": true in orbitpush.json instead');
    }

    const served = SERVED_STATUS.get(status);
    if (!served) return skip(`status ${statusToken} is not supported, only redirects`);

    try {
      const { pattern, params } = toPattern(from);
      const target = to.replace(/:([A-Za-z_]\w*)/g, (placeholder, name: string) => {
        if (/^https?$/.test(name) && to.startsWith(`${name}:`)) return placeholder;

        const index = params.get(name);
        if (index === undefined) throw new Error(`":${name}" is not defined in "${from}"`);

        return name === "splat" ? `%{Path.${index}-}` : `%{Path.${index}}`;
      });
      // bunny.net rejects a relative redirect target as "not a valid URL"
      const absolute = target.startsWith("/") ? `https://%{Url.Hostname}${target}` : target;
      rules.push(
        rule({
          description: [from, to, served, ...conditions].join(" "),
          pattern,
          conditions: countries.length
            ? [{ Type: COUNTRY_CODE, PatternMatchingType: 0, PatternMatches: countries }]
            : [],
          actions: [
            { ActionType: REDIRECT, ActionParameter1: absolute, ActionParameter2: String(served) },
          ],
        }),
      );
      if (served !== status) {
        warnings.push(`_redirects:${n} status ${status} is sent as ${served}: ${line}`);
      }
    } catch (error) {
      skip(errorMessage(error));
    }
  });

  return { rules, warnings };
}

export function parseHeaders(text: string): Parsed {
  const rules: EdgeRule[] = [];
  const warnings: string[] = [];
  const blocks: { n: number; path: string; headers: Map<string, string[]> }[] = [];

  for (const [n, line, indented] of lines(text)) {
    if (!indented) {
      blocks.push({ n, path: line, headers: new Map() });
      continue;
    }

    const block = blocks.at(-1);
    const colon = line.indexOf(":");
    if (!block || colon < 1) {
      warnings.push(`_headers:${n} skipped (expected "Name: value" below a path): ${line}`);
      continue;
    }

    const name = line.slice(0, colon).trim();
    const values = block.headers.get(name) ?? [];
    block.headers.set(name, [...values, line.slice(colon + 1).trim()]);
  }

  for (const { n, path, headers } of blocks) {
    const actions = [...headers].map(([name, values]) => ({
      ActionType: SET_RESPONSE_HEADER,
      ActionParameter1: name,
      ActionParameter2: values.join(", "),
    }));
    if (!isNonEmpty(actions)) {
      warnings.push(`_headers:${n} skipped (no indented "Name: value" lines below it): ${path}`);
      continue;
    }

    try {
      const { pattern } = toPattern(path);
      rules.push(rule({ description: `headers ${path}`, pattern, actions }));
    } catch (error) {
      warnings.push(`_headers:${n} skipped (${errorMessage(error)}): ${path}`);
    }
  }

  return { rules, warnings };
}

function lines(text: string): [number, string, boolean][] {
  return text
    .split(/\r?\n/)
    .map((raw, i): [number, string, boolean] => [i + 1, raw.trim(), /^\s/.test(raw)])
    .filter(([, line]) => line && !line.startsWith("#"));
}

function isNonEmpty<T>(items: T[]): items is [T, ...T[]] {
  return items.length > 0;
}
