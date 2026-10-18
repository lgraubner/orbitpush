# orbitpush

Deploy a static site or SPA to **your own** [bunny.net](https://bunny.net) account: a storage zone with a pull zone in front. No server, no platform, bring your own key.

```bash
export BUNNY_API_KEY=...   # https://dash.bunny.net/account/api-key
npx orbitpush init         # creates storage zone + pull zone, writes orbitpush.json
npm run build
npx orbitpush deploy       # uploads, syncs edge rules, purges the cache
```

`orbitpush disable`, `orbitpush enable` and `orbitpush destroy` take a site offline, bring it back, or delete it from bunny.net (see below).

## `orbitpush init`

Asks for the project name, build output directory, a custom domain and its aliases, the main storage region, replication regions and CDN delivery regions. Then it creates:

1. a storage zone (name = project name),
2. a pull zone with the storage zone as its origin (available at `https://<name>.b-cdn.net`),
3. the custom domain and its aliases, and requests a free SSL certificate for each.

For a custom domain, point a `CNAME` record to `<name>.b-cdn.net`. For an apex domain (`example.com`) you need a DNS provider that supports `ALIAS`/CNAME flattening. If DNS is not set up yet, the certificate is requested again on every deploy until it works.

Each prompt can be skipped with a flag. Use `--yes` for non-interactive setup:

```bash
npx orbitpush init --name my-site --dir dist --domain www.example.com --alias example.com --region DE --yes
```

The pull zone and storage zone names are global across bunny.net. If the name is taken, choose another one.

If `init` fails before `orbitpush.json` is written, it deletes the zones it just created, so you can run it again with the same name. If that cleanup fails too, `init` names the zone to delete in the dashboard. Failures after that point, such as a missing SSL certificate, are fixed by the next deploy.

## `orbitpush deploy`

1. Reads `orbitpush.json`, `BUNNY_API_KEY` and the rule files. A missing `_headers` or `_redirects` means no rules of that kind. A rule file that exists but cannot be read stops the deploy before anything changes.
2. Compares the output directory with the storage zone using SHA256 checksums and uploads only changed files, HTML files last.
3. Applies the settings: [SPA mode](#spa-mode) or the [404 page](#404-page) from the output directory, and replication regions, delivery regions and domains from `orbitpush.json`.
4. Turns `_headers` and `_redirects` into edge rules (see below).
5. Deletes files from the storage zone that are no longer in the build.
6. Purges the pull zone cache.

bunny.net applies edge rule changes one by one, a few seconds after `deploy` finishes (2–6 s in our tests).

In CI, set `BUNNY_API_KEY` as a secret:

```yaml
- run: npx orbitpush deploy
  env:
    BUNNY_API_KEY: ${{ secrets.BUNNY_API_KEY }}
```

## `orbitpush.json`

Commit this file. It never contains the API key.

```json
{
  "$schema": "https://unpkg.com/orbitpush/schema.json",
  "name": "my-site",
  "outputDir": "dist",
  "domain": "www.example.com",
  "aliases": ["example.com"],
  "region": "DE",
  "replicationRegions": ["NY"],
  "geoZones": ["EU", "US"],
  "storageZoneId": 123456,
  "pullZoneId": 654321
}
```

Settings are applied on every deploy, so you can change them later:

| Field                | Notes                                                                                                                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outputDir`          | Directory that gets deployed.                                                                                                                                                                            |
| `domain`             | Optional. Custom domain, added with SSL. Removing it does **not** remove it from bunny.net.                                                                                                              |
| `aliases`            | Optional. Hostnames added with SSL that 301-redirect every path and query to `domain`. Need a `domain`. At most 8: bunny.net allows 10 hostnames per pull zone, `<name>.b-cdn.net` and `domain` included |
| `region`             | Main storage region. Fixed after `init`.                                                                                                                                                                 |
| `replicationRegions` | Can only be added. bunny.net does not support removing replication regions.                                                                                                                              |
| `geoZones`           | CDN delivery regions: `EU`, `US`, `ASIA`, `SA`, `AF`. At least one.                                                                                                                                      |
| `trailingSlash`      | Optional. `always`, `never` or `ignore`, see [Trailing slashes](#trailing-slashes).                                                                                                                      |

### Domains and search engines

Each hostname in `aliases` redirects to `domain` with status `301`, keeping the path and query string, so `https://example.com/a?b=1` goes to `https://www.example.com/a?b=1`. An alias needs the same DNS record as a domain.

While `domain` is set, responses on `<name>.b-cdn.net` carry `X-Robots-Tag: noindex`, so search engines index the custom domain instead.

Both are edge rules that orbitpush manages, like the ones from the rule files below.

## `orbitpush disable` and `orbitpush enable`

`disable` adds an edge rule named `orbitpush disabled` that blocks every request to the pull zone, then purges the cache. Visitors get bunny.net's `403` page on every hostname. Files, settings and domains stay as they are, and `deploy` keeps working but leaves the block in place and warns about it. `enable` removes the rule and purges the cache again. Both do nothing when the site is already in that state.

## `orbitpush destroy`

Deletes the pull zone (with its hostnames and certificates), then the storage zone with every file in it, then `orbitpush.json`. It asks you to type the project name first; `--yes` skips that and is required without a terminal. A zone that is already gone counts as deleted, so if `destroy` stops halfway, run it again. DNS records you created for your domains are not managed by orbitpush; remove them at your DNS provider.

## `_headers` and `_redirects`

Both files use the [Netlify format](https://docs.netlify.com/manage/routing/redirects/overview/) and are read from the root of the output directory. They are not uploaded. Each redirect and each `_headers` path block becomes one edge rule.

Rules created by orbitpush have a description that starts with `orbitpush <hash>`. On deploy, new or changed rules are added, rules that no longer exist in the files are deleted, and every other orbitpush rule is rewritten from the files, so edits made to it in the dashboard are undone. Edge rules you create yourself in the dashboard are never touched. To take over an orbitpush rule, remove the `orbitpush` prefix from its description; the next deploy then adds a fresh copy unless you also remove the line from the files.

Unsupported lines print a warning and are skipped. They do not fail the deploy.

bunny.net allows 50 edge rules per pull zone by default; bunny.net support can raise the limit. Besides one rule per redirect line and per `_headers` block, orbitpush adds one per alias, one for noindex while `domain` is set, one for the [trailing slash](#trailing-slashes) and one while the site is disabled. Rules created in the dashboard count too. bunny.net accepts no change to a full zone, so a deploy can use 49 rules; when it would need more, it fails before uploading anything and says how many rules it needs.

### `_redirects`

```
# _redirects
/old            /new
/blog/:year/:id /posts/:year/:id   302
/docs/*         https://docs.example.com/:splat   302
https://example.com/*  https://www.example.com/:splat  301!
```

Compared with Netlify's [redirect options](https://docs.netlify.com/manage/routing/redirects/redirect-options/), section by section:

| Netlify feature                                                    | orbitpush | Notes                                                                                                                                                                      |
| ------------------------------------------------------------------ | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status `301` (default) and `302`                                   | ✅        |                                                                                                                                                                            |
| Status `303`, `307`, `308`                                         | ⚠️        | bunny.net serves only `301` and `302`: `303` and `307` are sent as `302`, `308` as `301`, with a warning                                                                   |
| Status `404` for a path (`/shop /closed 404`)                      | ❌        | Skipped with a warning                                                                                                                                                     |
| Status `200` rewrites and proxies                                  | ❌        | A storage zone can't serve another path. Only `/* /index.html 200` works, as [SPA mode](#spa-mode)                                                                         |
| Custom `404.html`                                                  | ✅        | See [404 page](#404-page)                                                                                                                                                  |
| 404 pages per path (`/en/* /en/404.html 404`)                      | ❌        | Only the global 404 page                                                                                                                                                   |
| Force with `!`                                                     | ✅        | Accepted, and every redirect behaves as forced                                                                                                                             |
| Shadowing: a redirect without `!` only applies if no file exists   | ❌        | Edge rules run before the storage zone is asked                                                                                                                            |
| Splats: `*` at the end, `:splat` in the target                     | ✅        | `*` in the middle of a path or inside a segment (`/a/*/b`, `/file-*.js`) is skipped, as on Netlify                                                                         |
| Rule order: the first matching redirect wins                       | ✅        |                                                                                                                                                                            |
| Placeholders (`:name`)                                             | ✅        | As whole segments only: `/a-:id` is skipped                                                                                                                                |
| Query parameter matching (`/store id=:id /blog/:id`)               | ❌        | Skipped with a warning                                                                                                                                                     |
| Query string passed on to the target                               | ⚠️        | Only when the target ends in `:splat` or a placeholder: `/docs/a?x=1` goes to `…/a?x=1`, but `/old?x=1` goes to `/new`                                                     |
| Trailing slash: a rule matches with and without it                 | ✅        |                                                                                                                                                                            |
| Pretty URLs: `/about` redirects to `/about/`                       | ✅        | [`trailingSlash`](#trailing-slashes) `always`, the default                                                                                                                 |
| Pretty URLs: `/about.html` is served at `/about/`                  | ❌        | A storage zone can't serve another path                                                                                                                                    |
| Domain-level redirects (`https://blog.example.com/* …`)            | ✅        | One rule matches both `http` and `https`                                                                                                                                   |
| Proxy to another host (`… https://backend.example.com/:splat 200`) | ❌        |                                                                                                                                                                            |
| `Country=`                                                         | ✅        | Two-letter codes. Several `Country=` conditions on one line match any of their countries. Every 5 countries take one edge rule, because a bunny.net rule matches at most 5 |
| `Language=`                                                        | ❌        | Skipped with a warning                                                                                                                                                     |
| `Role=`                                                            | ❌        | Needs Netlify Identity                                                                                                                                                     |
| `Cookie=`                                                          | ❌        | Skipped with a warning                                                                                                                                                     |
| Redirects in `netlify.toml`                                        | ❌        | Only `_redirects` is read                                                                                                                                                  |

A relative target (`/new`) redirects on the hostname that was requested.

### `_headers`

```
# _headers
/*
  X-Frame-Options: DENY
/assets/*
  Cache-Control: public, max-age=31536000, immutable
```

Compared with Netlify's [custom headers](https://docs.netlify.com/manage/routing/headers/), section by section:

| Netlify feature                                                                                                                                                                                                   | orbitpush | Notes                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_headers` in the publish directory                                                                                                                                                                               | ✅        | Read from the root of the output directory and not uploaded                                                                                                                                              |
| `[[headers]]` in `netlify.toml`                                                                                                                                                                                   | ❌        | Only `_headers` is read                                                                                                                                                                                  |
| Comments with `#`, also indented below a path                                                                                                                                                                     | ✅        |                                                                                                                                                                                                          |
| Header names are case-insensitive                                                                                                                                                                                 | ✅        | `Cache-Control` and `cache-control` in one block are joined, sent with the first spelling                                                                                                                |
| `/*` for every path                                                                                                                                                                                               | ✅        |                                                                                                                                                                                                          |
| Wildcards: `*` anywhere in a path, matching any characters                                                                                                                                                        | ✅        | `/assets/*.js` also matches `/assets/lib/app.js`, as on Netlify                                                                                                                                          |
| Placeholders: `:name` as a whole segment                                                                                                                                                                          | ✅        |                                                                                                                                                                                                          |
| A wildcard and a placeholder in one segment (`/t/:name*`)                                                                                                                                                         | ❌        | Skipped with a warning; Netlify doesn't support it either                                                                                                                                                |
| Multi-value headers: the same name listed several times                                                                                                                                                           | ✅        | Joined with `, `, Netlify joins with `,`. Both mean the same in HTTP                                                                                                                                     |
| Most response headers, such as `Content-Type`, `Cache-Control` or `Content-Security-Policy`                                                                                                                       | ✅        |                                                                                                                                                                                                          |
| `Set-Cookie`                                                                                                                                                                                                      | ✅        | Served as written                                                                                                                                                                                        |
| Headers Netlify ignores: `Accept-Ranges`, `Age`, `Allow`, `Alt-Svc`, `Connection`, `Content-Encoding`, `Content-Length`, `Content-Range`, `Date`, `Location`, `Server`, `Trailer`, `Transfer-Encoding`, `Upgrade` | ✅        | Skipped with a warning, as are names starting with `CDN-`. bunny.net rejects several of them, which would fail the deploy                                                                                |
| Headers on proxied URLs and functions                                                                                                                                                                             | –         | orbitpush has no proxies or functions                                                                                                                                                                    |
| Headers per branch or deploy context                                                                                                                                                                              | –         | orbitpush has no deploy contexts. Copying a different `_headers` into the output directory in the build works the same                                                                                   |
| Cookies across subdomains only on a custom domain                                                                                                                                                                 | ⚠️        | `b-cdn.net` is not on the [Public Suffix List](https://publicsuffix.org/), so other sites on `b-cdn.net` can set cookies for `<name>.b-cdn.net`. Use a custom domain for anything that relies on cookies |
| Basic authentication (`Basic-Auth: user:password`)                                                                                                                                                                | ❌        | Skipped with a warning, so the password is never sent as a header                                                                                                                                        |

Not on Netlify's page:

- If several path blocks set the same header for a URL, the last block in the file wins, as on Netlify
- Headers also apply to the 404 page, to redirects and to the `index.html` that [SPA mode](#spa-mode) serves

## Trailing slashes

bunny.net serves `guides/index.html` at both `/guides` and `/guides/`. At `/guides`, relative links such as `./intro.html` resolve to `/intro.html` and break. Set `trailingSlash` in `orbitpush.json` to pick one form:

- `always` (default): a path whose last segment has no file extension, such as `/guides`, redirects with `301` to `/guides/`. Only HTML responses redirect, so files without an extension, such as `.well-known/apple-app-site-association`, are served as they are. Like Netlify's Pretty URLs, except that `/about.html` is not served at `/about/`: a storage zone can't serve another path. A missing path such as `/nope` redirects to `/nope/` and then gets the 404.
- `never`: `/guides/` redirects with `301` to `/guides`, except when the URL has a query string.
- `ignore`: no redirect. This is the default in [SPA mode](#spa-mode), where client routes such as `/projects` have no directory.

The redirect drops the query string, like a redirect with a fixed target in `_redirects`. It is an edge rule that orbitpush manages, and redirects from `_redirects` run first.

## Caching

Browsers get `Cache-Control: public, max-age=0` for every file, so they check for a new version on every visit, as on Netlify, and a deploy shows up right away. bunny.net still caches every file at its edge until the next deploy purges it.

For files whose name changes with their content, such as the fingerprinted assets of most build tools, set a long cache time in `_headers`:

```
/assets/*
  Cache-Control: public, max-age=31536000, immutable
```

A `Cache-Control` from `_headers` also applies to bunny.net's edge: with `max-age=0` or `no-cache`, every request for those files goes to the storage zone.

## 404 page

Without SPA mode, a `404.html` in the root of the output directory is served with status `404` for every missing file.

## Development

```bash
npm install            # also installs the lefthook git hooks
npm test               # vitest, no network
npm run format         # oxfmt
npm run lint           # oxlint with type-aware rules
npm run build          # type-checks and bundles everything into dist/cli.js (no runtime dependencies)
npm run check          # format check, lint, build and tests: must pass before a change is done
npm run test:e2e       # Playwright against real bunny.net, see below
```

`npm run test:e2e` deploys each demo site in `e2e/sites/` to the bunny.net account of `BUNNY_API_KEY`, tests it in Chromium, then disables, enables and destroys it. It creates real zones named `orbitpush-e2e-<site>-<run>`; if a run is killed, delete leftovers in the dashboard. Set `E2E_COUNTRY` to the two-letter code of where you run it (`E2E_COUNTRY=de`) to also test a matching `Country=` redirect. Custom hostnames under `E2E_DOMAIN` need no DNS records: requests to them connect to `<name>.b-cdn.net`, so SSL certificates are not tested.

Dependencies are pinned to exact versions. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`type(scope): subject`); a lefthook `commit-msg` hook runs commitlint and rejects other messages.

## License

MIT
