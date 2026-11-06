# Settings

The settings in `orbitpush.json` are applied on every deploy: replication regions, CDN delivery regions on the pull zone (with `EnableHostnameVary: true` and `CacheControlPublicMaxAgeOverride: 0`), the primary domain and aliases with free SSL, and the trailing slash rule. Editing the file and deploying is how users change them. SPA mode and the 404 page are also storage zone settings, but come from the SPA mode redirect `{ "from": "/*", "to": "/index.html", "status": 200 }` in `redirects` and a `404.html` in the output directory.

## Sub-features

- `settings-spa` with the SPA mode redirect in `redirects` serves `/index.html` with status 200 for unknown extensionless paths.
- `settings-404` without that redirect and with a `404.html` in the output serves it for missing files; without the file, no custom 404.
- `settings-replication` sends the replication regions without the main region.
- `settings-geo` enables exactly the listed delivery regions.
- `settings-domains` adds the primary domain, requests SSL and forces HTTPS once a certificate exists; a removed domain or alias stays, and every deploy warns about each pull zone hostname that is neither `<name>.b-cdn.net` nor in `orbitpush.json`. `deploy --prune-hostnames` removes those hostnames instead (`DELETE /pullzone/<id>/removeHostname`).
- `settings-aliases` adds each alias with SSL like the primary domain and, once the primary domain has a certificate, writes a managed 301 rule to `https://<domain>%{Url.Path}`. Until then deploy writes no alias rule and warns ``<alias> will redirect to <domain> once it has HTTPS. Run `orbitpush domains add <domain>` to finish it.`` With a domain, a managed `X-Robots-Tag: noindex` rule matches `<name>.b-cdn.net`, lowercased. Both come before the rules from `redirects` and `headers`.
- `settings-trailing-slash` adds one managed rule for `trailingSlash` `always` (the default, redirect extensionless HTML paths to `/`) or `never` (redirect `/path/` away from the slash); `ignore` adds none. SPA mode defaults it to `ignore`; an explicit `trailingSlash` overrides that.
- `settings-invalid` rejects an invalid `orbitpush.json` with a list of problems before any request.

## How to get to it (user POV)

- Answer the region prompts of `init`, or edit `orbitpush.json` and run `orbitpush deploy`. init asks nothing about domains, aliases, SPA mode or trailing slashes. `orbitpush domains add` is the usual way to add a domain (`features/domains.md`); editing `domain` and `aliases` and deploying still works.
- For SPA mode, add `{ "from": "/*", "to": "/index.html", "status": 200 }` to `redirects` in `orbitpush.json` and run `orbitpush deploy`.

## Driving it with ctl.sh

Preconditions:

- `init` with `--name verify-f --dir public --yes` exited `0` (delivery regions `EU` and `US`), then the fixture rules were merged: `jq -s '.[0] + .[1]' orbitpush.json rules.json > o.json && mv o.json orbitpush.json` in the work dir.

- **SPA.** Deploy once. The summary's storage zone has `Custom404FilePath: "/404.html"`, `Rewrite404To200: false` and `ReplicationRegions: []`, and the pull zone `EnableHostnameVary: true` and `CacheControlPublicMaxAgeOverride: 0`. Set `"redirects"` to only `[{ "from": "/*", "to": "/index.html", "status": 200 }]` and deploy: `Edge rules: 4 removed, 2 kept`. The storage zone has `Custom404FilePath: "/index.html"` and `Rewrite404To200: true`, no edge rule is added for it, the `trailing slash always` rule is gone, and stderr has no `redirects` warning. Set `"redirects": []` and deploy: `Rewrite404To200: false` and `Custom404FilePath: "/404.html"` again, and the trailing slash rule returns (`Edge rules: 1 added, 2 kept`). With the SPA redirect, setting `"trailingSlash": "always"` brings the rule back as well.
- **404.** Delete `public/404.html` and deploy: `Files: 1 deleted, ...` and `Custom404FilePath` is `""`.
- **Regions.** Set `"replicationRegions": ["DE", "NY"]` and `"geoZones": ["EU", "ASIA"]` and deploy. stderr shows `Project    verify-f (DE, replicated to NY)`. The storage zone has `ReplicationRegions: ["NY"]`, and the pull zone has `EnableGeoZoneEU` and `EnableGeoZoneASIA` true and the other three false.
- **Domains.** Set `"domain": "www.example.test"` and deploy. stderr shows ``! Add this DNS record, then run `orbitpush domains add www.example.test` to finish:`` and `www.example.test CNAME verify-f.b-cdn.net`, no SSL warning, and `Edge rules: 1 added, 3 kept`: the noindex rule. Deploy again: stderr warns ``DNS for www.example.test does not point to bunny.net yet. Add this record, then run `orbitpush domains add www.example.test`:`` with the line `www.example.test CNAME verify-f.b-cdn.net` below it. Deploy again with `FAKE_BUNNY_CERT=ok` before `--`: no SSL warning, `✔ Deployed to https://www.example.test`; the hostname has `HasCertificate` and `ForceSSL` true.
- **Aliases.** After the Domains step (the primary domain has its certificate), set `"aliases": ["Example.test"]` and deploy with `FAKE_BUNNY_CERT=ok`: `Aliases    Example.test`, the root-domain line `At the root of a domain, use ALIAS, ANAME or CNAME flattening instead of CNAME.` and `Edge rules: 1 added, 4 kept`. `Hostnames` gains `example.test`; edge rules at OrderIndex 0 and 1 are `orbitpush <hash> alias example.test www.example.test` (ActionParameter1 `https://www.example.test%{Url.Path}`) and `orbitpush <hash> noindex <name>.b-cdn.net`. Setting `aliases` without `domain` fails with `aliases: aliases need a domain to redirect to`. Remove both `domain` and `aliases` and deploy: `Edge rules: 2 removed, 3 kept`, the alias and noindex rules are gone, both hostnames are still in `Hostnames`, and stderr warns `<host> is on the pull zone but not in orbitpush.json, so it serves the site without a redirect.` for each. `deploy --prune-hostnames` then prints `› Removing hostname <host>` and sends one `DELETE /pullzone/<id>/removeHostname` per hostname.
- **Alias held back.** In a fresh run after `init`, without merging the fixture rules, set `"domain": "www.example.test"` and `"aliases": ["example.test"]` and deploy without `FAKE_BUNNY_CERT`: `! example.test will redirect to www.example.test once it has HTTPS. ...`, `Edge rules: 2 added` (noindex and trailing slash), and no alias rule. The warning repeats on each deploy until the primary domain is connected.
- **Trailing slash.** Without the SPA mode redirect, deploy: `trailing slash always` is the last rule. Set `"trailingSlash": "never"` and deploy: `Edge rules: 1 added, 1 removed, 2 kept`, the rule is `trailing slash never` with ActionParameter1 `https://%{Url.Hostname}/%{Path.0-}`. Set `"ignore"` and deploy: `Edge rules: 1 removed, 2 kept`, no trailing slash rule. (Counts assume the fixture headers and no domain.)
- **Invalid.** Set `"region": "XX"` and `"geoZones": ["MARS"]` and deploy. Exit `1`, stderr `✖ Invalid orbitpush.json:` followed by one line each for `region` and `geoZones.0`, and no new request appears. An unknown key such as `"foo": 1` fails the same way with `Unrecognized key: "foo"`.
- **Live.** After an approved live deploy with the SPA mode redirect in `redirects`: `curl -sS -o /dev/null -w '%{http_code}' https://verify-$RUN.b-cdn.net/some/route` gives `200` with the `index.html` body; `/missing.js` gives `404`.

## Gotchas

- bunny.net cannot remove replication regions. The fake accepts any list, so a removal that bunny.net rejects only shows live.
- The main `region` cannot change after init. deploy never sends it to bunny.net; it only drops it from the `ReplicationRegions` it sends, and it must still be valid.
- `Rewrite404To200` affects only paths without a file extension on bunny.net. Offline you can see the flag, not that behavior.
