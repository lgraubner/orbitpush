import { expect, test } from "vitest";

import { parseHeaders, parseRedirects, toPattern } from "../src/rules.ts";

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
});

test("redirects", () => {
  const { rules, warnings } = parseRedirects(`
# comment
/home              /
/blog/:year/:slug  /news/:year/:slug  302
/docs/*            https://docs.example.com/:splat  308!
/*                 /index.html  200
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
  expect(warnings).toHaveLength(7);
  expect(warnings.find((w) => w.startsWith("_redirects:6 "))).toMatch(/spa/);
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
`);
  expect(rules).toEqual([]);
  expect(warnings).toHaveLength(4);
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
