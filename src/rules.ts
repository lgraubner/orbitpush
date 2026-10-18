import { createHash } from "node:crypto";

// Bunny edge rule enums: https://docs.bunny.net/api-reference/core/pull-zone/addupdate-edge-rule
const REDIRECT = 1;
const SET_RESPONSE_HEADER = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
export const RULE_PREFIX = "orbitpush ";

export type EdgeRule = {
  ActionType: number;
  ActionParameter1: string;
  ActionParameter2: string;
  ExtraActions: { ActionType: number; ActionParameter1: string; ActionParameter2: string }[];
  Triggers: { Type: 0; PatternMatchingType: 0; PatternMatches: string[] }[];
  TriggerMatchingType: 0;
  Description: string;
  Enabled: true;
};

export type Parsed = { rules: EdgeRule[]; warnings: string[] };

// Netlify path ("/blog/:slug/*" or "https://host/path") -> Lua pattern on the full request URL,
// plus the segment index of each placeholder for building %{Path.N} targets.
export function toPattern(from: string) {
  const match = /^(?:https?:\/\/([^/]+))?(\/.*)$/.exec(from);
  if (!match) throw new Error(`invalid path "${from}"`);
  const [, host, path] = match;
  const segments = path.split("/").slice(1);
  const params = new Map<string, number>();
  const parts = segments.map((segment, index) => {
    if (segment === "*") {
      if (index !== segments.length - 1)
        throw new Error(`"*" must be the last segment in "${from}"`);
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
  // Netlify matches with and without trailing slash.
  if (!pattern.endsWith(".*")) pattern = pattern.replace(/\/?$/, "/?");
  const hostPattern = host ? host.replace(/[\^$()%.[\]*+\-?]/g, "%$&") : "[^/]+";
  return { pattern: `pattern:^https?://${hostPattern}${pattern}$`, params };
}

function rule(
  description: string,
  pattern: string,
  actions: { ActionType: number; ActionParameter1: string; ActionParameter2: string }[],
): EdgeRule {
  const [first, ...extra] = actions;
  const body = {
    ...first,
    ExtraActions: extra,
    Triggers: [{ Type: 0 as const, PatternMatchingType: 0 as const, PatternMatches: [pattern] }],
    TriggerMatchingType: 0 as const,
    Enabled: true as const,
  };
  // The hash lets deploy keep unchanged rules and only touch the ones that differ.
  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 10);
  return { ...body, Description: `${RULE_PREFIX}${hash} ${description}`.slice(0, 255) };
}

export function parseRedirects(text: string): Parsed {
  const rules: EdgeRule[] = [];
  const warnings: string[] = [];
  lines(text).forEach(([n, line]) => {
    const skip = (why: string) => warnings.push(`_redirects:${n} skipped (${why}): ${line}`);
    const tokens = line.split(/\s+/);
    if (tokens.length < 2) return skip("missing target");
    const [from, to, statusToken = "301", ...rest] = tokens;
    if (to.includes("=")) return skip("query parameter matching is not supported");
    if (rest.length) return skip("conditions are not supported");
    const status = Number(statusToken.replace(/!$/, ""));
    if (status === 200 && /^\/\*$/.test(from) && /^\/index\.html$/.test(to))
      return skip('set "spa": true in orbitpush.json instead');
    if (!REDIRECT_STATUSES.has(status))
      return skip(`status ${statusToken} is not supported, only redirects`);
    try {
      const { pattern, params } = toPattern(from);
      const target = to.replace(/:([A-Za-z_]\w*)/g, (placeholder, name: string) => {
        if (/^https?$/.test(name) && to.startsWith(`${name}:`)) return placeholder;
        const index = params.get(name);
        if (index === undefined) throw new Error(`":${name}" is not defined in "${from}"`);
        return name === "splat" ? `%{Path.${index}-}` : `%{Path.${index}}`;
      });
      rules.push(
        rule(`${from} ${to} ${status}`, pattern, [
          { ActionType: REDIRECT, ActionParameter1: target, ActionParameter2: String(status) },
        ]),
      );
    } catch (error) {
      skip((error as Error).message);
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
    if (!headers.size) continue;
    try {
      const { pattern } = toPattern(path);
      const actions = [...headers].map(([name, values]) => ({
        ActionType: SET_RESPONSE_HEADER,
        ActionParameter1: name,
        ActionParameter2: values.join(", "),
      }));
      rules.push(rule(`headers ${path}`, pattern, actions));
    } catch (error) {
      warnings.push(`_headers:${n} skipped (${(error as Error).message}): ${path}`);
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
