# Netlify parity

Which Netlify features for static sites can be built on a storage zone and pull zone. Researched 2026-10-18 against the [edge rule API](https://bunny.net/docs/api-reference/core/pull-zone/addupdate-edge-rule). Rows marked _inferred_ or _guess_ have not been tried against a real pull zone.

orbitpush uses two edge rule actions today, `Redirect` (1) and `SetResponseHeader` (5), and sets `OrderIndex` to the file position.

## Covered

| Netlify                                                                             | orbitpush                     |
| ----------------------------------------------------------------------------------- | ----------------------------- |
| Static deploy behind a CDN                                                          | storage zone + pull zone      |
| `_redirects` 301/302 (303/307 as 302, 308 as 301), `:placeholders`, `:splat`, hosts | edge rule `Redirect`          |
| `_headers`                                                                          | edge rule `SetResponseHeader` |
| `/* /index.html 200` (SPA mode), `404.html`                                         | storage zone settings         |
| Custom domains with free SSL                                                        | `addHostname` + certificate   |
| `Country=` condition                                                                | trigger `CountryCode` (4)     |
| Upload only changed files, cache purge                                              | SHA256 diff + purge           |

## Possible with edge rules

Measured on a throwaway pull zone on 2026-10-18 (evidence: `.verify-artifacts/lr143449/experiment.json`, local only). One sample per case.

| Netlify                                         | bunny.net                                        | Result                                                                                                     |
| ----------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Rule order                                      | `OrderIndex` on the edge rule                    | done: first matching redirect wins, last matching header wins, as on Netlify                               |
| `Language=` condition                           | trigger `RequestHeader` (1), `Parameter1` header | header name in `Parameter1` works; `en*` also matched `de-DE,en;q=0.8`, so matching is not anchored        |
| Query parameter matching (`/store id=:id`)      | trigger `UrlQueryString` (6), `%{Query.id}`      | `%{Query.id}` expands; the trigger matches the raw query string (`*id=*`), `Parameter1` seems ignored      |
| `Cookie=` condition                             | trigger `CookieValue` (10)                       | unresolved: `Parameter1: "ab"` with `*` matched without any cookie; `*ab=*` without `Parameter1` never did |
| Status per path (`/gone /404.html 410`)         | action `SetStatusCode` (14)                      | status 410 with the zone's 404 page as body                                                                |
| Proxy to an external URL (`200` to `https://…`) | action `OriginUrl` (2) with `%{Path.N-}`         | proxies; the forwarded path was not captured                                                               |
| Force HTTPS                                     | action `ForceSSL` (0) or pull zone setting       | not tested                                                                                                 |

Verified through orbitpush itself in run `lv144439`: relative targets, `Country=`, and both orders. A `308` redirect was served as `301`, and run `ls145226` showed `303` rejected with HTTP 400 "Invalid redirect status code". Other measurements: a `SetResponseHeader` rule also applies to a redirect response; the URL trigger ignores the query string; a relative redirect target is rejected with HTTP 400.

## Only with Edge Scripting

Action `RunEdgeScript` (21) runs a script on bunny.net's Deno-based runtime, a separate paid product. It is the only way to get:

- internal rewrites (`200` to another path in the same storage zone),
- Edge Functions and middleware,
- password protection or basic auth (`EnableTokenAuthentication` (9) is signed URLs, not the same),

Deploying edge scripts would make orbitpush a different product than a static deploy tool.

## Possible as new orbitpush features

- **Image transforms and minification**: bunny Optimizer, a paid pull zone setting.
- **Deploy previews and branch deploys**: a pull zone per branch or a path prefix per branch. Zone names are global, so names multiply.
- **Atomic deploys and rollback**: needs versioned prefixes and an origin switch. Today HTML is uploaded last, which is not atomic.
- **Split testing**: trigger `RandomChance` (7) with `OriginUrl` or `Redirect`. No sticky sessions without a script.
- **Analytics**: the statistics API gives CDN numbers, not page analytics.

## Not possible

Forms, Identity (and with it `Role=`), prerendering, Functions as a backend, and shadowing: edge rules run before the storage zone is asked, so a redirect cannot depend on whether a file exists (inferred).

## Open questions

- Pretty URLs: `/about/` probably serves `about/index.html`; `/about` probably does not serve `about.html`. Guess, untested.
