import { expect, test } from "vitest";

import type { Header, Redirect } from "../src/config.ts";
import {
  domainRules,
  headerRules,
  redirectRules,
  toPattern,
  trailingSlashRule,
} from "../src/rules.ts";

type RedirectInput = Omit<Redirect, "status"> & { status?: number };

const redirects = (...entries: RedirectInput[]) =>
  redirectRules(entries.map((entry) => ({ status: 301, ...entry })));
const headers = (...entries: Header[]) => headerRules(entries);

test("paths become Lua patterns on the full URL", () => {
  expect(toPattern("/").pattern).toBe("pattern:^https?://[^/]+/?$");
  expect(toPattern("/old-page.html").pattern).toBe("pattern:^https?://[^/]+/old%-page%.html/?$");
  expect(toPattern("/blog/:slug").pattern).toBe("pattern:^https?://[^/]+/blog/[^/]+/?$");
  expect(toPattern("/assets/*").pattern).toBe("pattern:^https?://[^/]+/assets/.*$");
  expect(toPattern("https://www.example.com/*").pattern).toBe(
    "pattern:^https?://www%.example%.com/.*$",
  );
  expect(() => toPattern("/a/*/b")).toThrow();
  expect(() => toPattern("/file-*.js")).toThrow();
  expect(() => toPattern("/a-:id")).toThrow();
});

test("redirects", () => {
  const { rules, warnings } = redirects(
    { from: "/home", to: "/" },
    { from: "/blog/:year/:slug", to: "/news/:year/:slug", status: 302 },
    { from: "/docs/*", to: "https://docs.example.com/:splat", status: 308, force: true },
    { from: "/api/*", to: "https://api.example.com/:splat", status: 200 },
    { from: "/store", to: "/blog/:id", query: { id: ":id" } },
    { from: "/en/*", to: "/en/404.html", status: 404 },
    { from: "/x", to: "/y", conditions: { Language: ["de"] } },
    { from: "/a/:b", to: "/c/:missing" },
  );
  expect(
    rules.map((r) => [r.Triggers[0].PatternMatches[0], r.ActionParameter1, r.ActionParameter2]),
  ).toEqual([
    ["pattern:^https?://[^/]+/home/?$", "https://%{Url.Hostname}/", "301"],
    [
      "pattern:^https?://[^/]+/blog/[^/]+/[^/]+/?$",
      "https://%{Url.Hostname}/news/%{Path.1}/%{Path.2}",
      "302",
    ],
    ["pattern:^https?://[^/]+/docs/.*$", "https://docs.example.com/%{Path.1-}", "301"],
  ]);
  expect(rules[0].ActionType).toBe(1);
  expect(rules[0].Description).toMatch(/^orbitpush [0-9a-f]{10} \/home \/ 301$/);
  expect(warnings).toHaveLength(6);
});

test("/* to /index.html with status 200 turns on SPA mode instead of becoming an edge rule", () => {
  expect(
    redirects({ from: "/old", to: "/new" }, { from: "/*", to: "/index.html", status: 200 }),
  ).toMatchObject({
    spa: true,
    warnings: [],
    rules: [{ ActionParameter1: "https://%{Url.Hostname}/new" }],
  });
  expect(redirects({ from: "/old", to: "/new" }).spa).toBe(false);

  for (const entry of [
    { from: "/*", to: "/index.html", status: 200, force: true },
    { from: "/*", to: "/index.html", status: 200, conditions: { Country: ["de"] } },
    { from: "/app/*", to: "/app/index.html", status: 200 },
    { from: "/*", to: "/index.html", status: 404 },
  ]) {
    const { spa, rules, warnings } = redirects(entry);
    expect({ entry, spa, rules }).toEqual({ entry, spa: false, rules: [] });
    expect(warnings).toHaveLength(1);
  }
});

test("headers", () => {
  const { rules, warnings } = headers(
    { for: "/*", values: { "X-Frame-Options": "DENY", Link: "</a.css>; rel=preload" } },
    { for: "/assets/*", values: { "Cache-Control": "public, max-age=31536000, immutable" } },
  );
  expect(rules).toHaveLength(2);
  expect(
    [rules[0], ...rules[0].ExtraActions].map((a) => [
      a.ActionType,
      a.ActionParameter1,
      a.ActionParameter2,
    ]),
  ).toEqual([
    [5, "X-Frame-Options", "DENY"],
    [5, "Link", "</a.css>; rel=preload"],
  ]);
  expect(rules[1].Triggers[0].PatternMatches[0]).toBe("pattern:^https?://[^/]+/assets/.*$");
  expect(warnings).toEqual([]);
});

test("unchanged rules keep their description, changed rules get a new one", () => {
  const a = redirects({ from: "/a", to: "/b" }).rules[0].Description;
  expect(redirects({ from: "/a", to: "/b", status: 301 }).rules[0].Description).toBe(a);
  expect(redirects({ from: "/a", to: "/c" }).rules[0].Description).not.toBe(a);
});

test("rule hashes stay stable across releases, so deployed managed rules are kept", () => {
  expect(redirects({ from: "/a", to: "/b" }).rules[0].Description).toBe(
    "orbitpush 29c4d1d733 /a /b 301",
  );
  expect(headers({ for: "/*", values: { "X-A": "1" } }).rules[0].Description).toBe(
    "orbitpush 93842498ac headers /*",
  );
});

test("a redirect target may carry a query string", () => {
  const { rules, warnings } = redirects(
    { from: "/a", to: "/b?ref=x" },
    { from: "/c", to: "https://example.com/?a=b", status: 302 },
  );
  expect(rules.map((r) => r.ActionParameter1)).toEqual([
    "https://%{Url.Hostname}/b?ref=x",
    "https://example.com/?a=b",
  ]);
  expect(warnings).toEqual([]);
});

test("a headers entry without values warns instead of vanishing", () => {
  const { rules, warnings } = headers({ for: "/*", values: {} });
  expect(rules).toEqual([]);
  expect(warnings).toEqual(['headers.0 skipped (no headers in "values"): /*']);
});

test("Country conditions add one country trigger that must match together with the path", () => {
  const { rules, warnings } = redirects(
    { from: "/", to: "/uk", status: 302, conditions: { Country: ["gb", "IE"] } },
    { from: "/shop/*", to: "/de/shop/:splat", conditions: { Country: ["de", "at"] } },
  );
  expect(
    rules.map((r) => [r.TriggerMatchingType, r.Triggers, r.ActionParameter1, r.ActionParameter2]),
  ).toEqual([
    [
      1,
      [
        { Type: 0, PatternMatchingType: 0, PatternMatches: ["pattern:^https?://[^/]+/?$"] },
        { Type: 4, PatternMatchingType: 0, PatternMatches: ["GB", "IE"] },
      ],
      "https://%{Url.Hostname}/uk",
      "302",
    ],
    [
      1,
      [
        { Type: 0, PatternMatchingType: 0, PatternMatches: ["pattern:^https?://[^/]+/shop/.*$"] },
        { Type: 4, PatternMatchingType: 0, PatternMatches: ["DE", "AT"] },
      ],
      "https://%{Url.Hostname}/de/shop/%{Path.1-}",
      "301",
    ],
  ]);
  expect(rules[0].Description).toMatch(/ \/ \/uk 302 Country=gb,IE$/);
  expect(warnings).toEqual([]);
});

test("a redirect with an unsupported or malformed condition is skipped", () => {
  const { rules, warnings } = redirects(
    { from: "/a", to: "/b", conditions: { Country: ["de"], Language: ["en"] } },
    { from: "/c", to: "/d", conditions: { Country: ["deu"] } },
    { from: "/e", to: "/f", conditions: { Cookie: ["ab"] } },
    { from: "/i", to: "/j", conditions: { Role: ["admin"] } },
  );
  expect(rules).toEqual([]);
  expect(warnings).toHaveLength(4);
  expect(warnings[1]).toContain('redirects.1 skipped (invalid country "deu", expected two-letter');
});

test("a relative redirect target keeps the requested host, because bunny.net rejects relative targets", () => {
  expect(redirects({ from: "/a", to: "/b" }).rules[0].ActionParameter1).toBe(
    "https://%{Url.Hostname}/b",
  );
  expect(redirects({ from: "/a", to: "https://example.com/b" }).rules[0].ActionParameter1).toBe(
    "https://example.com/b",
  );
});

test("a redirect code bunny.net does not serve is sent as the closest one it does, with a warning", () => {
  const { rules, warnings } = redirects(
    { from: "/a", to: "/b", status: 303 },
    { from: "/c", to: "/d", status: 307 },
    { from: "/e", to: "/f", status: 308, force: true },
    { from: "/g", to: "/h", status: 302 },
  );
  expect(rules.map((r) => r.ActionParameter2)).toEqual(["302", "302", "301", "302"]);
  expect(warnings).toHaveLength(3);
  expect(warnings[0]).toMatch(/^redirects\.0 .*303.*302/);
  expect(warnings[2]).toMatch(/^redirects\.2 .*308.*301/);
});

const headerActions = (rule: ReturnType<typeof headerRules>["rules"][number]) =>
  [rule, ...rule.ExtraActions].map((a) => [a.ActionParameter1, a.ActionParameter2]);

const matches = (rule: { Triggers: { PatternMatches: string[] }[] }, url: string) =>
  rule.Triggers[0].PatternMatches.some((p) =>
    new RegExp(p.replace(/^pattern:/, "").replace(/%(.)/g, "\\$1")).test(url),
  );

test("headers joins a header listed twice regardless of case, keeping the first spelling", () => {
  const { rules } = headers({
    for: "/*",
    values: { "Cache-Control": "max-age=0", "cache-control": "no-cache" },
  });

  expect(headerActions(rules[0])).toEqual([["Cache-Control", "max-age=0, no-cache"]]);
});

test("header paths take * anywhere, matching any characters as on Netlify", () => {
  const { rules, warnings } = headers(
    { for: "/assets/*.js", values: { "X-A": "js" } },
    { for: "/a/*/b", values: { "X-B": "b" } },
  );

  expect(warnings).toEqual([]);
  const [js, b] = rules;
  expect(matches(js, "https://site.b-cdn.net/assets/app.js")).toBe(true);
  expect(matches(js, "https://site.b-cdn.net/assets/lib/app.js")).toBe(true);
  expect(matches(js, "https://site.b-cdn.net/assets/app.css")).toBe(false);
  expect(matches(js, "https://site.b-cdn.net/assets/app.json")).toBe(false);
  expect(matches(b, "https://site.b-cdn.net/a/x/b")).toBe(true);
  expect(matches(b, "https://site.b-cdn.net/a/x/y/b")).toBe(true);
  expect(matches(b, "https://site.b-cdn.net/a/b")).toBe(false);
});

test("headers skips a segment with both a placeholder and a wildcard, as on Netlify", () => {
  const { rules, warnings } = headers(
    { for: "/t/:name*", values: { "X-A": "a" } },
    { for: "/t/*:name", values: { "X-B": "b" } },
  );

  expect(rules).toEqual([]);
  expect(warnings).toHaveLength(2);
});

test("headers never sends Basic-Auth, which would publish the password", () => {
  const { rules, warnings } = headers({
    for: "/private/*",
    values: { "Basic-Auth": "user:secret", "X-A": "a" },
  });

  expect(headerActions(rules[0])).toEqual([["X-A", "a"]]);
  expect(JSON.stringify(rules)).not.toContain("secret");
  expect(warnings).toEqual(["headers.0.values.Basic-Auth skipped (not supported)"]);
});

test("headers skips headers that Netlify ignores or bunny.net reserves, each with a warning", () => {
  const names = [
    "Accept-Ranges",
    "Age",
    "Allow",
    "Alt-Svc",
    "Connection",
    "content-encoding",
    "Content-Length",
    "Content-Range",
    "Date",
    "Location",
    "Server",
    "Trailer",
    "Transfer-Encoding",
    "Upgrade",
    "CDN-Cache",
  ];
  const { rules, warnings } = headers({
    for: "/*",
    values: {
      ...Object.fromEntries(names.map((name) => [name, "x"])),
      "Set-Cookie": "a=1",
      "Content-Type": "text/plain",
    },
  });

  expect(headerActions(rules[0])).toEqual([
    ["Set-Cookie", "a=1"],
    ["Content-Type", "text/plain"],
  ]);
  expect(warnings).toHaveLength(names.length);
});

test("the trailing slash rule redirects only HTML responses, so files without an extension are served", () => {
  const [rule] = trailingSlashRule("always");

  expect(rule.TriggerMatchingType).toBe(1);
  expect(rule.Triggers).toContainEqual({
    Type: 2,
    PatternMatchingType: 0,
    Parameter1: "Content-Type",
    PatternMatches: ["text/html*"],
  });
});

test("a Country redirect with more than 5 countries becomes one rule per 5, because a trigger takes 5", () => {
  const { rules, warnings } = redirects({
    from: "/",
    to: "/eu",
    status: 302,
    conditions: { Country: ["de", "at", "ch", "fr", "it", "es", "nl"] },
  });

  expect(warnings).toEqual([]);
  expect(rules).toHaveLength(2);
  const countries = rules.map((r) => r.Triggers.find((t) => t.Type === 4)?.PatternMatches ?? []);
  expect(countries.every((c) => c.length <= 5)).toBe(true);
  expect(countries.flat().sort()).toEqual(["AT", "CH", "DE", "ES", "FR", "IT", "NL"]);
  expect(new Set(rules.map((r) => r.Triggers[0].PatternMatches[0])).size).toBe(1);
  expect(new Set(rules.map((r) => r.ActionParameter1)).size).toBe(1);
  expect(new Set(rules.map((r) => r.Description)).size).toBe(2);
});

test("the noindex rule matches the b-cdn.net host in lowercase, as browsers send it", () => {
  const rules = domainRules({ name: "MySite", domain: "www.example.com", aliases: [] });

  expect(rules.map((r) => r.Triggers[0].PatternMatches)).toEqual([
    ["pattern:^https?://mysite%.b%-cdn%.net/.*$"],
  ]);
});
