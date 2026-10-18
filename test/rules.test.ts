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
/x                 /y  301  Country=de
/a/:b              /c/:missing
`);
  expect(
    rules.map((r) => [r.Triggers[0].PatternMatches[0], r.ActionParameter1, r.ActionParameter2]),
  ).toEqual([
    ["pattern:^https?://[^/]+/home/?$", "/", "301"],
    ["pattern:^https?://[^/]+/blog/[^/]+/[^/]+/?$", "/news/%{Path.1}/%{Path.2}", "302"],
    ["pattern:^https?://[^/]+/docs/.*$", "https://docs.example.com/%{Path.1-}", "308"],
  ]);
  expect(rules[0].ActionType).toBe(1);
  expect(rules[0].Description).toMatch(/^orbitpush [0-9a-f]{10} \/home \/ 301$/);
  expect(warnings).toHaveLength(6);
  expect(warnings[0]).toMatch(/_redirects:6 .*spa/);
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
  expect(parseRedirects("/a /b").rules[0].Description).toBe("orbitpush cac3b5ea61 /a /b 301");
  expect(parseHeaders("/*\n  X-A: 1").rules[0].Description).toBe("orbitpush 93842498ac headers /*");
});
