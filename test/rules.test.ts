import { expect, test } from "vitest";

import { parseHeaders, parseRedirects, toPattern, trailingSlashRule } from "../src/rules.ts";

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
  const { rules, warnings } = parseRedirects(`
# comment
/home              /
/blog/:year/:slug  /news/:year/:slug  302
/docs/*            https://docs.example.com/:splat  308!
/api/*             https://api.example.com/:splat  200
/store id=:id      /blog/:id  301
/en/*              /en/404.html  404
/x                 /y  301  Language=de
/a/:b              /c/:missing
`);
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

test("/* /index.html 200 turns on SPA mode instead of becoming an edge rule", () => {
  expect(parseRedirects("/old /new\n/*  /index.html  200")).toMatchObject({
    spa: true,
    warnings: [],
    rules: [{ ActionParameter1: "https://%{Url.Hostname}/new" }],
  });
  expect(parseRedirects("/old /new").spa).toBe(false);

  for (const line of [
    "/* /index.html 200!",
    "/* /index.html 200 Country=de",
    "/app/* /app/index.html 200",
    "/* /index.html 404",
  ]) {
    const { spa, rules, warnings } = parseRedirects(line);
    expect({ line, spa, rules }).toEqual({ line, spa: false, rules: [] });
    expect(warnings).toHaveLength(1);
  }
});

test("headers", () => {
  const { rules, warnings } = parseHeaders(`
/*
  X-Frame-Options: DENY
  Link: </a.css>; rel=preload
  Link: </b.js>; rel=preload

/assets/*
  Cache-Control: public, max-age=31536000, immutable
  broken line
`);
  expect(rules).toHaveLength(2);
  expect(
    [rules[0], ...rules[0].ExtraActions].map((a) => [
      a.ActionType,
      a.ActionParameter1,
      a.ActionParameter2,
    ]),
  ).toEqual([
    [5, "X-Frame-Options", "DENY"],
    [5, "Link", "</a.css>; rel=preload, </b.js>; rel=preload"],
  ]);
  expect(rules[1].Triggers[0].PatternMatches[0]).toBe("pattern:^https?://[^/]+/assets/.*$");
  expect(warnings).toHaveLength(1);
});

test("unchanged rules keep their description, changed rules get a new one", () => {
  const a = parseRedirects("/a /b").rules[0].Description;
  expect(parseRedirects("/a   /b  301").rules[0].Description.split(" ")[1]).toBe(a.split(" ")[1]);
  expect(parseRedirects("/a /c").rules[0].Description).not.toBe(a);
});

test("rule hashes stay stable across releases, so deployed managed rules are kept", () => {
  expect(parseRedirects("/a /b").rules[0].Description).toBe("orbitpush 29c4d1d733 /a /b 301");
  expect(parseHeaders("/*\n  X-A: 1").rules[0].Description).toBe("orbitpush 93842498ac headers /*");
});

test("a redirect target may carry a query string", () => {
  const { rules, warnings } = parseRedirects("/a /b?ref=x\n/c https://example.com/?a=b 302");
  expect(rules.map((r) => r.ActionParameter1)).toEqual([
    "https://%{Url.Hostname}/b?ref=x",
    "https://example.com/?a=b",
  ]);
  expect(warnings).toEqual([]);
});

test("a _headers path without indented headers warns instead of vanishing", () => {
  const { rules, warnings } = parseHeaders("/*\nX-Frame-Options: DENY\n");
  expect(rules).toEqual([]);
  expect(warnings).toHaveLength(2);
});

test("Country= conditions add one country trigger that must match together with the path", () => {
  const { rules, warnings } = parseRedirects(`
/        /uk  302  Country=gb,IE
/shop/*  /de/shop/:splat  Country=de  Country=at
`);
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
  const { rules, warnings } = parseRedirects(`
/a  /b  301  Country=de  Language=en
/c  /d  301  Country=deu
/e  /f  301  Cookie=ab
/g  /h  301  extra
/i  /j  301  Role=admin
`);
  expect(rules).toEqual([]);
  expect(warnings).toHaveLength(5);
});

test("a relative redirect target keeps the requested host, because bunny.net rejects relative targets", () => {
  expect(parseRedirects("/a /b").rules[0].ActionParameter1).toBe("https://%{Url.Hostname}/b");
  expect(parseRedirects("/a https://example.com/b").rules[0].ActionParameter1).toBe(
    "https://example.com/b",
  );
});

test("a redirect code bunny.net does not serve is sent as the closest one it does, with a warning", () => {
  const { rules, warnings } = parseRedirects("/a /b 303\n/c /d 307\n/e /f 308!\n/g /h 302");
  expect(rules.map((r) => r.ActionParameter2)).toEqual(["302", "302", "301", "302"]);
  expect(warnings).toHaveLength(3);
  expect(warnings[0]).toMatch(/^_redirects:1 .*303.*302/);
  expect(warnings[2]).toMatch(/^_redirects:3 .*308.*301/);
});

const headerActions = (rule: ReturnType<typeof parseHeaders>["rules"][number]) =>
  [rule, ...rule.ExtraActions].map((a) => [a.ActionParameter1, a.ActionParameter2]);

const matches = (rule: { Triggers: { PatternMatches: string[] }[] }, url: string) =>
  rule.Triggers[0].PatternMatches.some((p) =>
    new RegExp(p.replace(/^pattern:/, "").replace(/%(.)/g, "\\$1")).test(url),
  );

test("_headers joins a header listed twice regardless of case, keeping the first spelling", () => {
  const { rules } = parseHeaders(`
/*
  Cache-Control: max-age=0
  cache-control: no-cache
`);

  expect(headerActions(rules[0])).toEqual([["Cache-Control", "max-age=0, no-cache"]]);
});

test("_headers skips comments, also indented ones below a path", () => {
  const { rules, warnings } = parseHeaders(`
# a path
/a
  # headers for that path
  X-Frame-Options: DENY
`);

  expect(headerActions(rules[0])).toEqual([["X-Frame-Options", "DENY"]]);
  expect(warnings).toEqual([]);
});

test("_headers paths take * anywhere, matching any characters as on Netlify", () => {
  const { rules, warnings } = parseHeaders(`
/assets/*.js
  X-A: js
/a/*/b
  X-B: b
`);

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

test("_headers skips a segment with both a placeholder and a wildcard, as on Netlify", () => {
  const { rules, warnings } = parseHeaders(`
/t/:name*
  X-A: a
/t/*:name
  X-B: b
`);

  expect(rules).toEqual([]);
  expect(warnings).toHaveLength(2);
});

test("_headers never sends Basic-Auth, which would publish the password", () => {
  const { rules, warnings } = parseHeaders(`
/private/*
  Basic-Auth: user:secret
  X-A: a
`);

  expect(headerActions(rules[0])).toEqual([["X-A", "a"]]);
  expect(JSON.stringify(rules)).not.toContain("secret");
  expect(warnings).toEqual([expect.stringMatching(/^_headers:3 skipped .*Basic-Auth/)]);
  expect(warnings[0]).not.toContain("secret");
});

test("_headers skips headers that Netlify ignores or bunny.net reserves, each with a warning", () => {
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
  const { rules, warnings } = parseHeaders(
    `/*\n${names.map((name) => `  ${name}: x`).join("\n")}\n  Set-Cookie: a=1\n  Content-Type: text/plain`,
  );

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
