# Settings

The settings in `orbitpush.json` are applied on every deploy: replication regions, CDN delivery regions on the pull zone, custom domains with free SSL, and the trailing slash rule. Editing the file and deploying is how users change them. SPA mode and the 404 page are also storage zone settings, but come from the output directory: the line `/* /index.html 200` in `_redirects` and a `404.html`.

## Sub-features

- `settings-spa` with `/* /index.html 200` in `_redirects` serves `/index.html` with status 200 for unknown extensionless paths.
- `settings-404` without that line and with a `404.html` in the output serves it for missing files; without the file, no custom 404.
- `settings-replication` sends the replication regions without the main region.
- `settings-geo` enables exactly the listed delivery regions.
- `settings-domains` adds the custom domain, requests SSL and forces HTTPS once a certificate exists; a removed domain or alias stays, and every deploy warns about each pull zone hostname that is neither `<name>.b-cdn.net` nor in `orbitpush.json`.
- `settings-aliases` adds each alias with SSL like a domain and writes a managed 301 rule to `https://<domain>%{Url.Path}`; with a domain, a managed `X-Robots-Tag: noindex` rule matches `<name>.b-cdn.net`, lowercased. Both come before the rule-file rules.
- `settings-trailing-slash` adds one managed rule for `trailingSlash` `always` (the default, redirect extensionless HTML paths to `/`) or `never` (redirect `/path/` away from the slash); `ignore` adds none. SPA mode defaults it to `ignore`.
- `settings-invalid` rejects an invalid `orbitpush.json` with a list of problems before any request.

## How to get to it (user POV)

- Answer the matching `init` prompts, or edit `orbitpush.json` and run `orbitpush deploy`.
- For SPA mode, add `/* /index.html 200` to `_redirects` in the output directory and run `orbitpush deploy`.

## Driving it with ctl.sh

Preconditions:

- `init` with `--name verify-f --dir public --yes` exited `0` (delivery regions `EU` and `US`). The fixture `_redirects` and `_headers` are in place.

- **404.** Deploy. The summary's storage zone has `Custom404FilePath: "/404.html"` and `Rewrite404To200: false`. Delete `public/404.html` and deploy: `Custom404FilePath` is `""`.
- **SPA.** Overwrite `public/_redirects` with only `/* /index.html 200` and deploy: `Updating edge rules (+0 ~2 -4)`. The storage zone has `Custom404FilePath: "/index.html"` and `Rewrite404To200: true`, no edge rule is added for the line, the `trailing slash always` rule is gone, and stderr has no `_redirects` warning. Delete the line and deploy: both are back to the 404 values and the trailing slash rule returns (`+1`).
- **Regions.** Set `"replicationRegions": ["DE", "NY"]` and `"geoZones": ["EU", "ASIA"]` and deploy. The storage zone has `ReplicationRegions: ["NY"]`, and the pull zone has `EnableGeoZoneEU` and `EnableGeoZoneASIA` true and the other three false.
- **Domains.** Set `"domain": "www.example.test"` and deploy. stderr warns `No SSL certificate for www.example.test yet`. Deploy again with `FAKE_BUNNY_CERT=ok` before `--`: no warning; the hostname has `HasCertificate` and `ForceSSL` true.
- **Aliases.** With `"domain": "www.example.test"`, set `"aliases": ["Example.test"]` and deploy. `Hostnames` gains `example.test`; edge rules at OrderIndex 0 and 1 are `orbitpush <hash> alias example.test www.example.test` (ActionParameter1 `https://www.example.test%{Url.Path}`) and `orbitpush <hash> noindex <name>.b-cdn.net`. Setting `aliases` without `domain` fails with `aliases: aliases need a domain to redirect to`. Remove both `domain` and `aliases` and deploy: `-2`, the alias and noindex rules are gone, and both hostnames are still in `Hostnames`.
- **Trailing slash.** Without the SPA line, deploy: `trailing slash always` is the last rule. Set `"trailingSlash": "never"` and deploy: `+1` and `-1`, the rule is `trailing slash never` with ActionParameter1 `https://%{Url.Hostname}/%{Path.0-}`. Set `"ignore"` and deploy: `-1`, no trailing slash rule.
- **Invalid.** Set `"region": "XX"` and `"geoZones": ["MARS"]` and deploy. Exit `1`, stderr `✖ Invalid orbitpush.json:` followed by one line each for `region` and `geoZones.0`, and no new request appears.
- **Live.** After an approved live deploy with the SPA line in `_redirects`: `curl -sS -o /dev/null -w '%{http_code}' https://verify-$RUN.b-cdn.net/some/route` gives `200` with the `index.html` body; `/missing.js` gives `404`.

## Gotchas

- bunny.net cannot remove replication regions. The fake accepts any list, so a removal that bunny.net rejects only shows live.
- The main `region` cannot change after init. Editing it changes nothing, because the CLI never sends it on deploy.
- `Rewrite404To200` affects only paths without a file extension on bunny.net. Offline you can see the flag, not that behavior.
