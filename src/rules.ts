import { createHash } from "node:crypto";

import { errorMessage } from "./log.ts";

// Bunny edge rule enums: https://docs.bunny.net/api-reference/core/pull-zone/addupdate-edge-rule
const REDIRECT = 1;
const BLOCK_REQUEST = 4;
const SET_RESPONSE_HEADER = 5;
const COUNTRY_CODE = 4;
const RESPONSE_HEADER = 2;
const QUERY_STRING = 6;
const MATCH_NONE = 2;
const MATCH_ALL = 1;
const COUNTRY_CONDITION = /^Country=([a-z]{2}(?:,[a-z]{2})*)$/i;
// bunny.net's default limits: 50 edge rules per pull zone and 5 patterns per trigger
export const MAX_EDGE_RULES = 50;
const MAX_PATTERNS = 5;
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

export function isManaged<T extends { Description: string | null }>(
  rule: T,
): rule is T & { Description: string } {
  return Boolean(rule.Description?.startsWith(RULE_PREFIX)) && rule.Description !== DISABLED_RULE;
}

type EdgeRuleAction = { ActionType: number; ActionParameter1: string; ActionParameter2: string };

type Trigger = {
  Type: 0 | typeof RESPONSE_HEADER | typeof COUNTRY_CODE | typeof QUERY_STRING;
  PatternMatchingType: 0 | typeof MATCH_NONE;
  Parameter1?: string;
  PatternMatches: string[];
};

export type EdgeRule = EdgeRuleAction & {
  ExtraActions: EdgeRuleAction[];
  Triggers: Trigger[];
  TriggerMatchingType: 0 | typeof MATCH_ALL;
  Description: string;
  Enabled: true;
};

export type Parsed = { rules: EdgeRule[]; warnings: string[] };

// bunny.net matches edge rule triggers against the full request URL, scheme and host included
const escapeLua = (text: string) => text.replace(/[\^$()%.[\]*+\-?]/g, "%$&");

export function toPattern(from: string, { wildcards = false } = {}) {
  const match = /^(?:https?:\/\/([^/]+))?(\/.*)$/.exec(from);
  if (!match) throw new Error(`invalid path "${from}"`);

  const [, host, path] = match;
  const segments = path.split("/").slice(1);
  const params = new Map<string, number>();
  const parts = segments.map((segment, index) => {
    if (segment.includes("*") && segment.includes(":")) {
      throw new Error(`a placeholder and "*" can't share a segment in "${from}"`);
    }

    // Netlify's _headers paths take * anywhere, matching any characters
    if (wildcards && segment.includes("*")) {
      return segment.split("*").map(escapeLua).join(".*");
    }

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
    if (segment.includes(":")) throw new Error(`":name" must be a whole segment in "${from}"`);

    return escapeLua(segment);
  });

  let pattern = `/${parts.join("/")}`;
  // Netlify matches with and without trailing slash
  if (!pattern.endsWith(".*")) pattern = pattern.replace(/\/?$/, "/?");

  const hostPattern = host ? escapeLua(host) : "[^/]+";

  return { pattern: `pattern:^https?://${hostPattern}${pattern}$`, params };
}

function rule({
  description,
  pattern,
  conditions = [],
  actions: [first, ...extra],
}: {
  description: string;
  pattern: string | string[];
  conditions?: Trigger[];
  actions: [EdgeRuleAction, ...EdgeRuleAction[]];
}): EdgeRule {
  const body = {
    ...first,
    ExtraActions: extra,
    Triggers: [
      { Type: 0, PatternMatchingType: 0, PatternMatches: [pattern].flat() },
      ...conditions,
    ],
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
  const cdnHost = `${name.toLowerCase()}.b-cdn.net`;

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
    description: `noindex ${cdnHost}`,
    pattern: toPattern(`https://${cdnHost}/*`).pattern,
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

export function trailingSlashRule(mode: "always" | "never" | "ignore"): EdgeRule[] {
  if (mode === "always") {
    const always = rule({
      description: "trailing slash always",
      pattern: ["pattern:^https?://[^/]+/[^/%.]+$", "pattern:^https?://[^/]+/.*/[^/%.]+$"],
      // Edge rules run before the storage zone is asked, so only the HTML response tells a
      // directory index apart from a file without an extension
      conditions: [
        {
          Type: RESPONSE_HEADER,
          PatternMatchingType: 0,
          Parameter1: "Content-Type",
          PatternMatches: ["text/html*"],
        },
      ],
      actions: [
        {
          ActionType: REDIRECT,
          // %{Url.Path} and %{Path.n} include the query string, Directory and FileName do not
          ActionParameter1: "https://%{Url.Hostname}%{Url.Directory}%{Url.FileName}/",
          ActionParameter2: "301",
        },
      ],
    });
    return [always];
  }

  if (mode === "never") {
    const never = rule({
      description: "trailing slash never",
      pattern: "pattern:^https?://[^/]+/.+/$",
      // %{Path.0-} keeps the query string and its slash, and bunny.net matches the pattern
      // without the query, so a request with a query would redirect to itself.
      conditions: [{ Type: QUERY_STRING, PatternMatchingType: MATCH_NONE, PatternMatches: ["*"] }],
      actions: [
        {
          ActionType: REDIRECT,
          ActionParameter1: "https://%{Url.Hostname}/%{Path.0-}",
          ActionParameter2: "301",
        },
      ],
    });
    return [never];
  }

  return [];
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

export function parseRedirects(text: string): Parsed & { spa: boolean } {
  const rules: EdgeRule[] = [];
  const warnings: string[] = [];
  let spa = false;

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

    if (from === "/*" && to === "/index.html" && statusToken === "200" && !conditions.length) {
      spa = true;
      return;
    }

    const status = Number(statusToken.replace(/!$/, ""));

    const served = SERVED_STATUS.get(status);
    if (!served) return skip(`status ${statusToken} is not supported, only redirects`);

    try {
      const { pattern, params } = toPattern(from);
      const target = to.replace(/:([A-Za-z_]\w*)/g, (_, name: string) => {
        const index = params.get(name);
        if (index === undefined) throw new Error(`":${name}" is not defined in "${from}"`);

        return name === "splat" ? `%{Path.${index}-}` : `%{Path.${index}}`;
      });
      // bunny.net rejects a relative redirect target as "not a valid URL"
      const absolute = target.startsWith("/") ? `https://%{Url.Hostname}${target}` : target;
      const groups = countries.length ? chunk(countries, MAX_PATTERNS) : [[]];
      for (const group of groups) {
        rules.push(
          rule({
            description: [from, to, served, ...conditions].join(" "),
            pattern,
            conditions: group.length
              ? [{ Type: COUNTRY_CODE, PatternMatchingType: 0, PatternMatches: group }]
              : [],
            actions: [
              {
                ActionType: REDIRECT,
                ActionParameter1: absolute,
                ActionParameter2: String(served),
              },
            ],
          }),
        );
      }
      if (served !== status) {
        warnings.push(`_redirects:${n} status ${status} is sent as ${served}: ${line}`);
      }
    } catch (error) {
      skip(errorMessage(error));
    }
  });

  return { rules, warnings, spa };
}

// Netlify ignores these, and bunny.net rejects the whole rule for some of them
const IGNORED_HEADERS = new Set([
  "accept-ranges",
  "age",
  "allow",
  "alt-svc",
  "connection",
  "content-encoding",
  "content-length",
  "content-range",
  "date",
  "location",
  "server",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function parseHeaders(text: string): Parsed {
  const rules: EdgeRule[] = [];
  const warnings: string[] = [];
  const blocks: {
    n: number;
    path: string;
    headers: Map<string, { name: string; values: string[] }>;
  }[] = [];

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
    const key = name.toLowerCase();
    if (key === "basic-auth") {
      warnings.push(
        `_headers:${n} skipped (Basic-Auth is not supported, it would publish the password)`,
      );
      continue;
    }

    if (IGNORED_HEADERS.has(key) || key.startsWith("cdn-")) {
      warnings.push(`_headers:${n} skipped (${name} is set by bunny.net): ${line}`);
      continue;
    }

    const header = block.headers.get(key) ?? { name, values: [] };
    header.values.push(line.slice(colon + 1).trim());
    block.headers.set(key, header);
  }

  for (const { n, path, headers } of blocks) {
    const actions = [...headers.values()].map(({ name, values }) => ({
      ActionType: SET_RESPONSE_HEADER,
      ActionParameter1: name,
      ActionParameter2: values.join(", "),
    }));
    if (!isNonEmpty(actions)) {
      warnings.push(`_headers:${n} skipped (no indented "Name: value" lines below it): ${path}`);
      continue;
    }

    try {
      const { pattern } = toPattern(path, { wildcards: true });
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

function chunk<T>(items: T[], size: number) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  );
}

function isNonEmpty<T>(items: T[]): items is [T, ...T[]] {
  return items.length > 0;
}
