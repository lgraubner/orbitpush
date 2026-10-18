import assert from "node:assert/strict";
import { test } from "node:test";

import { parseHeaders, parseRedirects, toPattern } from "../src/rules.ts";

test("paths become Lua patterns on the full URL", () => {
  assert.equal(toPattern("/").pattern, "pattern:^https?://[^/]+/?$");
  assert.equal(toPattern("/old-page.html").pattern, "pattern:^https?://[^/]+/old%-page%.html/?$");
  assert.equal(toPattern("/blog/:slug").pattern, "pattern:^https?://[^/]+/blog/[^/]+/?$");
  assert.equal(toPattern("/assets/*").pattern, "pattern:^https?://[^/]+/assets/.*$");
  assert.equal(toPattern("https://www.example.com/*").pattern, "pattern:^https?://www%.example%.com/.*$");
  assert.throws(() => toPattern("/a/*/b"));
  assert.throws(() => toPattern("/file-*.js"));
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
  assert.deepEqual(
    rules.map((r) => [r.Triggers[0].PatternMatches[0], r.ActionParameter1, r.ActionParameter2]),
    [
      ["pattern:^https?://[^/]+/home/?$", "/", "301"],
      ["pattern:^https?://[^/]+/blog/[^/]+/[^/]+/?$", "/news/%{Path.1}/%{Path.2}", "302"],
      ["pattern:^https?://[^/]+/docs/.*$", "https://docs.example.com/%{Path.1-}", "308"],
    ],
  );
  assert.equal(rules[0].ActionType, 1);
  assert.match(rules[0].Description, /^orbitpush [0-9a-f]{10} \/home \/ 301$/);
  assert.equal(warnings.length, 6);
  assert.match(warnings[0], /_redirects:6 .*spa/);
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
  assert.equal(rules.length, 2);
  assert.deepEqual(
    [rules[0], ...rules[0].ExtraActions].map((a) => [a.ActionType, a.ActionParameter1, a.ActionParameter2]),
    [
      [5, "X-Frame-Options", "DENY"],
      [5, "Link", "</a.css>; rel=preload, </b.js>; rel=preload"],
    ],
  );
  assert.equal(rules[1].Triggers[0].PatternMatches[0], "pattern:^https?://[^/]+/assets/.*$");
  assert.equal(warnings.length, 1);
});

test("unchanged rules keep their description, changed rules get a new one", () => {
  const a = parseRedirects("/a /b").rules[0].Description;
  assert.equal(parseRedirects("/a   /b  301").rules[0].Description.split(" ")[1], a.split(" ")[1]);
  assert.notEqual(parseRedirects("/a /c").rules[0].Description, a);
});
