# Edge rules

`_redirects` and `_headers` in the output directory become pull zone edge rules on deploy: one rule per redirect line (a `Country=` list of more than 5 codes splits into one rule per 5) and per `_headers` path block, after the domain rules and before the trailing slash rule (`features/settings.md`). Rules orbitpush manages carry the `orbitpush <hash>` description; changed lines replace their rule; dashboard rules are never touched. Unsupported lines print a warning and are skipped.

## Sub-features

- `rules-redirect` maps 301/302 redirects (303/307 sent as 302, 308 as 301, with a warning), placeholders and splats to Redirect rules.
- `rules-country` adds a Country Code trigger for `Country=` conditions, with `TriggerMatchingType` `1` (all triggers match). More than 5 codes split into one rule per 5 codes.
- `rules-headers` maps `_headers` blocks to Set Response Header rules, one action per header.
- `rules-warn` skips unsupported lines with a `_redirects:<line>` or `_headers:<line>` warning.
- `rules-sync` adds new rules, deletes managed rules that no longer exist, and rewrites every remaining managed rule with its existing Guid, so dashboard edits are undone.
- `rules-foreign` leaves rules without the `orbitpush ` prefix alone.
- `rules-live` bunny.net matches the patterns and serves the redirects and headers (live only).

## How to get to it (user POV)

- Put `_redirects` and `_headers` in the output directory root (as for Netlify), then run `orbitpush deploy`.

## Driving it with ctl.sh

Preconditions:

- `init` with `--name verify-e --dir public --yes` exited `0`. The fixture's rule files are unchanged.

- **Create.** Run `$C cli $RUN deploy-1 -- deploy`. stderr warns for `_redirects:4` (`status 308 is sent as 301`), `_redirects:6` (`status 200 is not supported, only redirects`) and `_redirects:7` (`query parameter matching is not supported`) and shows `Updating edge rules (+6 ~0 -0)`: five rule-file rules and `trailing slash always` at OrderIndex 5. The summary's `EdgeRules` contain `/old /about.html 301` with pattern `pattern:^https?://[^/]+/old/?$`; `/blog/:year/:id` → `https://%{Url.Hostname}/posts/%{Path.1}/%{Path.2}` `302`; `/docs/*` → `https://docs.example.com/%{Path.1-}` `301`; `headers /*` with `X-Frame-Options: DENY`; and `headers /assets/*` with the `Cache-Control` value.
- **Country.** Add `/ /uk 302 Country=gb,ie` to `public/_redirects` and deploy: `(+1 ~6 -0)`. The summary shows only each rule's first pattern, so read the `addOrUpdate` bodies in `bunny-state.json` `requests[]`: the rule for `/` has two triggers, the URL pattern and `{ Type: 4, PatternMatches: ["GB", "IE"] }`, and `TriggerMatchingType` `1`. The other rule-file rules keep `TriggerMatchingType` `0` and their descriptions; the trailing slash rule has `1` because of its `Content-Type` trigger. Then add `/x /y 302 Country=gb,ie,fr,de,nl,be` and deploy: `(+2 ...)`, two `/x` rules with `["GB","IE","FR","DE","NL"]` and `["BE"]`.
- **Change.** Change the `/old` target to `/index.html` and deploy. stderr shows `Updating edge rules (+1 ~6 -1)` (after the first Country line). The `/old` rule now targets `/index.html`, and the other descriptions are unchanged.
- **Remove.** Delete `public/_headers` and deploy. stderr shows `-2`, and no `headers` rule is left.
- **Foreign rule.** No CLI path creates a dashboard rule offline. Prove `rules-foreign` live: add a rule in the bunny.net dashboard, deploy, and check it is still there. Or read it in `test/deploy.test.ts` and report it as not driven.
- **Live.** After an approved live deploy of the fixture: `curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' https://verify-$RUN.b-cdn.net/old` gives `301` to `/about.html`; `/blog/2024/hello` gives `302` to `/posts/2024/hello`; `/docs/a/b` gives `301` to `https://docs.example.com/a/b`; `curl -sSI` on `/` shows `X-Frame-Options: DENY`; on `/assets/app.js` it shows the `Cache-Control` value. For `rules-country`, `curl -sS -o /dev/null -w '%{http_code}' https://verify-$RUN.b-cdn.net/` from outside GB and IE gives `200`, not `302`. Save each output in the evidence dir.

## Gotchas

- Offline proves which rules orbitpush sends, not that bunny.net's Lua patterns match. `npm run test:e2e` proves the patterns, redirects and headers live.
- Edge rules go live one by one, 2–6 s after deploy, so a check right after deploy can see some rules and not others. Wait for the rule written last.
- bunny.net caches responses across hostnames, including headers set by edge rules, unless `EnableHostnameVary` is on. Deploy turns it on.
- A trigger takes at most 5 patterns, a rule at most 5 triggers, and a pull zone holds 50 edge rules by default. On a full zone bunny.net rejects every edge rule write, updates included, so deploy allows 49 and deletes first when adding first would fill the zone.
- A pull zone holds 10 hostnames by default, `<name>.b-cdn.net` included, so `aliasProblem()` allows 8 aliases.
- bunny.net rejects a whole rule with HTTP 400 when it sets `Server`, `Content-Length`, `Accept-Ranges`, `Connection`, `Date` or a `CDN-` header. `parseHeaders()` skips them.
- Set Response Header rules apply to 404 responses and to redirect responses.
- A redirect can trigger on a response header (trigger `Type: 2`, `Parameter1: "Content-Type"`). The trailing slash rule uses it to redirect only HTML, so files without an extension are served.
- Pattern matching ignores the query string. `%{Url.Path}` and `%{Path.n}` include it; `%{Url.Directory}` and `%{Url.FileName}` do not. `%{Path.0}` is the first segment.
- bunny.net runs rules by `OrderIndex`. The first matching redirect wins and the last matching `SetResponseHeader` wins (measured in run `lr143449`). orbitpush sets `OrderIndex` to the file position, and rewrites every kept rule on each deploy, so `~n` in `Updating edge rules` counts all kept rules, not only moved ones.
- bunny.net rejects a relative redirect target with HTTP 400 "The entered path is not a valid URL". orbitpush sends `https://%{Url.Hostname}/…`.
- A storage zone can answer 401 for a few seconds after `init`: the first deploy right after `init` failed in two of three live runs (`lr143339`, `lv144439`), and a retry 20 s later worked.
- bunny.net serves only `301` and `302`: `308` was served as `301` (run `lv144439`) and `303` was rejected with HTTP 400 (run `ls145226`). `307` is untested live.
- New pull zones can take a minute before `b-cdn.net` answers. Retry curl before reporting a failure.
