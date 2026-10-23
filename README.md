# orbitpush

Deploy a static site or SPA to **your own** [bunny.net](https://bunny.net) account: a storage zone with a pull zone in front. No server, no platform, bring your own key.

```bash
export BUNNY_API_KEY=...                     # https://dash.bunny.net/account/api-key
npm run build
npx orbitpush deploy                         # first run: sets up the site, then deploys
npx orbitpush domains add www.example.com    # optional: your own domain
```

`orbitpush disable`, `orbitpush enable` and `orbitpush destroy` take a site offline, bring it back, or delete it from bunny.net (see below).

## `orbitpush init`

Sets up a site without deploying it. In a terminal you rarely need it: the first `deploy` asks the same questions. It asks for the project name, build output directory, the main storage region, replication regions and CDN delivery regions. Then it creates:

1. a storage zone (name = project name),
2. a pull zone with the storage zone as its origin (available at `https://<name>.b-cdn.net`),
3. with `--domain` and `--alias`, those hostnames on the pull zone, and prints the DNS record for each.

Domains are not asked for: add them with [`orbitpush domains add`](#orbitpush-domains), which waits for DNS and turns on HTTPS. For a domain given to `init`, run `domains add` for it once its DNS record is set.

Each prompt can be skipped with a flag; an option no command knows stops with an error. Without a terminal, `init` needs `--name` and `--dir`, or `--yes` to take the defaults:

```bash
npx orbitpush init --name my-site --dir dist --domain www.example.com --alias example.com --region DE --delivery-region EU --delivery-region US --yes
```

The pull zone and storage zone names are global across bunny.net. If the name is taken, choose another one.

If `init` fails before `orbitpush.json` is written, it deletes the zones it just created, so you can run it again with the same name. If that cleanup fails too, `init` names the zone to delete in the dashboard. Failures after that point, such as a missing SSL certificate, are fixed by the next deploy.

## `orbitpush deploy`

In a terminal, `deploy` without an `orbitpush.json` asks whether to set up a new site, asks the `init` questions, and deploys right after. The output directory must exist, so build first. Without a terminal it stops with an error instead, so CI never creates a site.

1. Reads `orbitpush.json` and `BUNNY_API_KEY`.
2. Compares the output directory with the storage zone using SHA256 checksums and uploads only changed files, HTML files last. A symlinked file is uploaded with the content it points to; a symlinked directory or a broken symlink is skipped with a warning.
3. Applies the settings: [SPA mode](#spa-mode) or the [404 page](#404-page) from the output directory, and replication regions, delivery regions and domains from `orbitpush.json`.
4. Turns `redirects` and `headers` into edge rules (see below).
5. Deletes files from the storage zone that are no longer in the build.
6. Purges the pull zone cache.

bunny.net applies edge rule changes one by one, a few seconds after `deploy` finishes (2–6 s in our tests).

A hostname on the pull zone that `orbitpush.json` does not list, such as a removed alias or a former `domain`, keeps serving the site without a redirect, and `deploy` warns about it. `orbitpush domains remove <host>` removes one; `orbitpush deploy --prune-hostnames` removes every such hostname except `<name>.b-cdn.net`, with its certificate, including hostnames added in the dashboard. A former primary domain usually belongs in `aliases` instead, so that its links redirect to the new one: `orbitpush domains add <host>`.

In CI, set `BUNNY_API_KEY` as a secret:

```yaml
- run: npx orbitpush deploy
  env:
    BUNNY_API_KEY: ${{ secrets.BUNNY_API_KEY }}
```

## `orbitpush domains`

Puts the site on your own domains. Each command updates `domain` and `aliases` in `orbitpush.json` and the pull zone together, so editing the file and running `deploy` stays an alternative.

```bash
npx orbitpush domains add www.example.com            # the first domain becomes the primary domain
npx orbitpush domains add example.com                # later ones are aliases that redirect to it
npx orbitpush domains add example.com --primary      # make an alias the primary domain
npx orbitpush domains remove example.com
npx orbitpush domains list
```

`domains add` adds the hostname to the pull zone, prints the DNS record to create, and waits until the record points to bunny.net: it checks after 5, 10, 20 and 40 seconds, then every minute for up to 15 minutes. Then it gets a free SSL certificate, turns on HTTPS and writes the alias redirects. If DNS takes longer, or you stop it with Ctrl+C, run the same command again later: it continues where it stopped. Without a terminal it checks once and exits with status `1` while the domain is not connected.

With `--primary`, the domain becomes the primary domain only once it is connected, and the former primary domain becomes an alias that redirects to it. Until then it stays an alias, so visitors are never sent to a domain without HTTPS.

`domains remove` removes the hostname from `orbitpush.json` and the pull zone. A primary domain that still has aliases cannot be removed: remove the aliases first, or make another domain primary.

`domains list` changes nothing. It shows each domain, whether it is connected, and the DNS record it still needs.

## Without a terminal (CI, scripts, agents)

orbitpush asks nothing when stdin or stderr is not a terminal, or when `CI` is set to anything but `false` or `0`. Every question then has to be answered by a flag, and the API key comes from `BUNNY_API_KEY`:

```bash
export BUNNY_API_KEY=...
npx orbitpush init --name my-site --dir dist --region DE --delivery-region EU --delivery-region US --yes
npm run build
npx orbitpush deploy
npx orbitpush domains add www.example.com   # prints the DNS record, exits 1 until it is set
```

- Commit `orbitpush.json` after `init`. Without a terminal, `deploy` never creates a site; it stops when the file is missing.
- `init` stops unless it gets `--name` and `--dir`, or `--yes`, so a guessed name never creates zones.
- `deploy`, `disable` and `enable` take no input. `destroy` needs `--yes`.
- `domains add` checks DNS once instead of waiting and exits `1` while the domain is not connected; run it again a few minutes later. `domains list` exits `1` while any domain is not connected, so a script can poll it.
- Errors go to stderr with exit code `1`, an unknown command exits with `2`, and an unknown option stops with `1`, so a typo never falls back to a default.
- Some coding agents run commands in a pseudo-terminal, where orbitpush would ask its questions and wait. Set `CI=1` for them: then nothing asks, and `domains add` checks once instead of waiting up to 15 minutes.

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

Settings are applied on every deploy, so you can change them later. A key not listed here, such as a misspelled field, makes `orbitpush.json` invalid:

| Field                | Notes                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outputDir`          | Directory that gets deployed.                                                                                                                                                                                                                                                                                                                                                       |
| `domain`             | Optional. Primary domain, a hostname such as `www.example.com`, added with SSL. Set by `orbitpush domains add`. Removing it here does **not** remove it from bunny.net; `deploy` warns about it. Use `orbitpush domains remove` instead.                                                                                                                                            |
| `aliases`            | Optional. Hostnames added with SSL that 301-redirect every path and query to `domain`. Need a `domain`, and each is listed once. At most 8: bunny.net allows 10 hostnames per pull zone, `<name>.b-cdn.net` and `domain` included. Removing one leaves it on the pull zone, serving the site without a redirect; `deploy` warns about it, and `orbitpush domains remove` removes it |
| `region`             | Main storage region. Fixed after `init`.                                                                                                                                                                                                                                                                                                                                            |
| `replicationRegions` | Can only be added. bunny.net does not support removing replication regions.                                                                                                                                                                                                                                                                                                         |
| `geoZones`           | CDN delivery regions: `EU`, `US`, `ASIA`, `SA`, `AF`. At least one.                                                                                                                                                                                                                                                                                                                 |
| `redirects`          | Optional. See [Redirects and headers](#redirects-and-headers).                                                                                                                                                                                                                                                                                                                      |
| `headers`            | Optional. See [Redirects and headers](#redirects-and-headers).                                                                                                                                                                                                                                                                                                                      |
| `trailingSlash`      | Optional. `always`, `never` or `ignore`, see [Trailing slashes](#trailing-slashes).                                                                                                                                                                                                                                                                                                 |

### Domains and search engines

Each hostname in `aliases` redirects to `domain` with status `301`, keeping the path and query string, so `https://example.com/a?b=1` goes to `https://www.example.com/a?b=1`. An alias needs the same DNS record as a domain. To swap an alias with `domain`, swap them in `orbitpush.json` and deploy: the old alias redirect is deleted before the new one is added, so the two never redirect in a loop. Aliases redirect only once `domain` has an SSL certificate: until then they serve the site themselves, so a swap to a domain whose DNS is not set yet never sends visitors to a hostname without HTTPS.

While `domain` is set, responses on `<name>.b-cdn.net` carry `X-Robots-Tag: noindex`, so search engines index the primary domain instead.

Both are edge rules that orbitpush manages, like the ones from the rule files below.

## `orbitpush migrate-netlify`

Copies the redirects and headers of a Netlify site into `orbitpush.json`. Run it after `init`, in the directory with `orbitpush.json`:

1. Reads `netlify.toml` from the current directory and `_redirects` and `_headers` from the output directory. If your build copies those files into it, build first.
2. Writes them to `redirects` and `headers` in `orbitpush.json`: `_redirects` first, then the `[[redirects]]` of `netlify.toml`, the order Netlify applies them in. Headers keep the same order, `_headers` first, so `netlify.toml` wins when both set a header for a URL; Netlify does not document this order.
3. Warns about every rule that `deploy` will skip because bunny.net can't serve it, such as rewrites or `Language` conditions. These rules are still written, so the file stays a complete copy.

It does not copy `Basic-Auth` headers, which hold passwords, or redirects without `to`. It stops without writing when `orbitpush.json` already has redirects or headers, and it never changes or deletes the Netlify files, so the site keeps working on Netlify. Everything else in `netlify.toml`, such as the build command or functions, is ignored. It rewrites `orbitpush.json` in the format `init` writes, so fields left out before, such as an empty `aliases`, appear with their defaults.

## `orbitpush disable` and `orbitpush enable`

`disable` adds an edge rule named `orbitpush disabled` that blocks every request to the pull zone, then purges the cache. Visitors get bunny.net's `403` page on every hostname. Files, settings and domains stay as they are, and `deploy` keeps working but leaves the block in place and warns about it. `enable` removes the rule and purges the cache again. Both do nothing when the site is already in that state.

## `orbitpush destroy`

Deletes the pull zone (with its hostnames and certificates), then the storage zone with every file in it, then `orbitpush.json`. It asks you to type the project name first; `--yes` skips that and is required without a terminal. A zone that is already gone counts as deleted, so if `destroy` stops halfway, run it again. DNS records you created for your domains are not managed by orbitpush; remove them at your DNS provider.

## Redirects and headers

`redirects` and `headers` in `orbitpush.json` take the shape of `[[redirects]]` and `[[headers]]` in Netlify's [`netlify.toml`](https://docs.netlify.com/build/configure-builds/file-based-configuration/), written as JSON. Each redirect and each headers entry becomes one edge rule.

`_redirects` and `_headers` files in the root of the output directory are neither read nor uploaded, so a site can keep them for Netlify. `deploy` warns about each one, and until `orbitpush.json` has rules it suggests the command below. Copy their rules to `orbitpush.json` with [`orbitpush migrate-netlify`](#orbitpush-migrate-netlify). After that, a change to a file does not reach orbitpush, and a change to `orbitpush.json` does not reach Netlify.

Rules created by orbitpush have a description that starts with `orbitpush <hash>`. On deploy, new or changed rules are added, rules that are no longer in `orbitpush.json` are deleted, and every other orbitpush rule is rewritten from `orbitpush.json`, so edits made to it in the dashboard are undone. Edge rules you create yourself in the dashboard are never touched. To take over an orbitpush rule, remove the `orbitpush` prefix from its description; the next deploy then adds a fresh copy unless you also remove the entry from `orbitpush.json`.

Unsupported entries print a warning, such as `redirects.3 skipped (...)`, and are skipped. They do not fail the deploy. An entry with a missing field, a field of the wrong type or an unknown key makes `orbitpush.json` invalid.

bunny.net allows 50 edge rules per pull zone by default; bunny.net support can raise the limit. Besides one rule per redirect and per headers entry, orbitpush adds one per alias, one for noindex while `domain` is set, one for the [trailing slash](#trailing-slashes) and one while the site is disabled. Rules created in the dashboard count too. bunny.net accepts no change to a full zone, so a deploy can use 49 rules; when it would need more, it fails before uploading anything and says how many rules it needs.

### `redirects`

```json
"redirects": [
  { "from": "/old", "to": "/new" },
  { "from": "/blog/:year/:id", "to": "/posts/:year/:id", "status": 302 },
  { "from": "/docs/*", "to": "https://docs.example.com/:splat", "status": 302 },
  { "from": "/", "to": "/uk", "status": 302, "conditions": { "Country": ["gb", "ie"] } },
  { "from": "https://example.com/*", "to": "https://www.example.com/:splat", "force": true }
]
```

| Field        | Notes                                                                       |
| ------------ | --------------------------------------------------------------------------- |
| `from`       | Path, or a full URL to match one host                                       |
| `to`         | Path or URL. A relative target (`/new`) redirects on the requested hostname |
| `status`     | Optional, default `301`                                                     |
| `force`      | Optional. Accepted, and every redirect behaves as forced                    |
| `query`      | Optional. Not supported: the redirect is skipped with a warning             |
| `conditions` | Optional. Only `Country` is supported                                       |

Compared with Netlify's [redirect options](https://docs.netlify.com/manage/routing/redirects/redirect-options/), section by section:

| Netlify feature                                                      | orbitpush | Notes                                                                                                                  |
| -------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------- |
| Status `301` (default) and `302`                                     | ✅        |                                                                                                                        |
| Status `303`, `307`, `308`                                           | ⚠️        | bunny.net serves only `301` and `302`: `303` and `307` are sent as `302`, `308` as `301`, with a warning               |
| Status `404` for a path                                              | ❌        | Skipped with a warning                                                                                                 |
| Status `200` rewrites and proxies                                    | ❌        | A storage zone can't serve another path. Only `/*` to `/index.html` with `200` works, as [SPA mode](#spa-mode)         |
| Custom `404.html`                                                    | ✅        | See [404 page](#404-page)                                                                                              |
| 404 pages per path (`/en/*` to `/en/404.html` with `404`)            | ❌        | Only the global 404 page                                                                                               |
| `force`                                                              | ✅        | Accepted, and every redirect behaves as forced                                                                         |
| Shadowing: a redirect without `force` only applies if no file exists | ❌        | Edge rules run before the storage zone is asked                                                                        |
| Splats: `*` at the end, `:splat` in the target                       | ✅        | `*` in the middle of a path or inside a segment (`/a/*/b`, `/file-*.js`) is skipped, as on Netlify                     |
| Rule order: the first matching redirect wins                         | ✅        |                                                                                                                        |
| Placeholders (`:name`)                                               | ✅        | As whole segments only: `/a-:id` is skipped                                                                            |
| Query parameter matching (`query`)                                   | ❌        | Skipped with a warning                                                                                                 |
| Query string passed on to the target                                 | ⚠️        | Only when the target ends in `:splat` or a placeholder: `/docs/a?x=1` goes to `…/a?x=1`, but `/old?x=1` goes to `/new` |
| Trailing slash: a rule matches with and without it                   | ✅        |                                                                                                                        |
| Pretty URLs: `/about` redirects to `/about/`                         | ✅        | [`trailingSlash`](#trailing-slashes) `always`, the default                                                             |
| Pretty URLs: `/about.html` is served at `/about/`                    | ❌        | A storage zone can't serve another path                                                                                |
| Domain-level redirects (`https://blog.example.com/*`)                | ✅        | One rule matches both `http` and `https`                                                                               |
| Proxy to another host, `headers` and `signed` on a proxy             | ❌        | `headers` and `signed` make `orbitpush.json` invalid                                                                   |
| `Country` condition                                                  | ✅        | Two-letter codes. Every 5 countries take one edge rule, because a bunny.net rule matches at most 5                     |
| `Language` condition                                                 | ❌        | Skipped with a warning                                                                                                 |
| `Role` condition                                                     | ❌        | Needs Netlify Identity                                                                                                 |
| `Cookie` condition                                                   | ❌        | Skipped with a warning                                                                                                 |
| A `_redirects` file                                                  | ❌        | Stops the deploy, see above                                                                                            |

### SPA mode

The redirect `{ "from": "/*", "to": "/index.html", "status": 200 }` turns on SPA mode: the storage zone serves `index.html` with status `200` for a missing path without a file extension. It is not an edge rule. With `force` or `conditions` it is skipped with a warning.

### `headers`

```json
"headers": [
  { "for": "/*", "values": { "X-Frame-Options": "DENY" } },
  { "for": "/assets/*", "values": { "Cache-Control": "public, max-age=31536000, immutable" } }
]
```

Compared with Netlify's [custom headers](https://docs.netlify.com/manage/routing/headers/), section by section:

| Netlify feature                                                                                                                                                                                                   | orbitpush | Notes                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[[headers]]` with `for` and `values`                                                                                                                                                                             | ✅        | As JSON in `orbitpush.json`                                                                                                                                                                              |
| A `_headers` file                                                                                                                                                                                                 | ❌        | Stops the deploy, see above                                                                                                                                                                              |
| Header names are case-insensitive                                                                                                                                                                                 | ✅        | `Cache-Control` and `cache-control` in one entry are joined with `, `, sent with the first spelling                                                                                                      |
| `/*` for every path                                                                                                                                                                                               | ✅        |                                                                                                                                                                                                          |
| Wildcards: `*` anywhere in a path, matching any characters                                                                                                                                                        | ✅        | `/assets/*.js` also matches `/assets/lib/app.js`, as on Netlify                                                                                                                                          |
| Placeholders: `:name` as a whole segment                                                                                                                                                                          | ✅        |                                                                                                                                                                                                          |
| A wildcard and a placeholder in one segment (`/t/:name*`)                                                                                                                                                         | ❌        | Skipped with a warning; Netlify doesn't support it either                                                                                                                                                |
| Multi-value headers                                                                                                                                                                                               | ✅        | Write the values in one string, separated by `, `                                                                                                                                                        |
| Most response headers, such as `Content-Type`, `Cache-Control` or `Content-Security-Policy`                                                                                                                       | ✅        |                                                                                                                                                                                                          |
| `Set-Cookie`                                                                                                                                                                                                      | ✅        | Served as written                                                                                                                                                                                        |
| Headers Netlify ignores: `Accept-Ranges`, `Age`, `Allow`, `Alt-Svc`, `Connection`, `Content-Encoding`, `Content-Length`, `Content-Range`, `Date`, `Location`, `Server`, `Trailer`, `Transfer-Encoding`, `Upgrade` | ✅        | Skipped with a warning, as are names starting with `CDN-`. bunny.net rejects several of them, which would fail the deploy                                                                                |
| Headers on proxied URLs and functions                                                                                                                                                                             | –         | orbitpush has no proxies or functions                                                                                                                                                                    |
| Headers per branch or deploy context                                                                                                                                                                              | –         | orbitpush has no deploy contexts                                                                                                                                                                         |
| Cookies across subdomains only on your own domain                                                                                                                                                                 | ⚠️        | `b-cdn.net` is not on the [Public Suffix List](https://publicsuffix.org/), so other sites on `b-cdn.net` can set cookies for `<name>.b-cdn.net`. Use your own domain for anything that relies on cookies |
| Basic authentication (`Basic-Auth`)                                                                                                                                                                               | ❌        | Skipped with a warning, so the password is never sent as a header                                                                                                                                        |

Not on Netlify's page:

- If several entries set the same header for a URL, the last entry wins, as on Netlify
- Headers also apply to the 404 page, to redirects and to the `index.html` that [SPA mode](#spa-mode) serves

### Moving from Netlify or Vercel

From Netlify, run [`orbitpush migrate-netlify`](#orbitpush-migrate-netlify). The way back is a copy: each entry in `redirects` and `headers` is one `[[redirects]]` or `[[headers]]` block of `netlify.toml` with the same keys.

`vercel.json` uses the same top-level names with different fields, so its entries need rewriting:

| `vercel.json`                                     | `orbitpush.json`                                                                                                |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `redirects[].source`, `destination`               | `from`, `to`                                                                                                    |
| `/blog/:path*` to `/news/:path*`                  | `/blog/*` to `/news/:splat`                                                                                     |
| `/:slug` (one segment)                            | `/:slug`                                                                                                        |
| Regex in `source`, such as `/(.*)` or `:id(\\d+)` | Not supported; `/(.*)` is `/*`                                                                                  |
| `permanent` (default `true`, sends `308`)         | `status`, default `301`. `308` is sent as `301`, `307` as `302`                                                 |
| `statusCode`                                      | `status`                                                                                                        |
| `has` / `missing`                                 | Not supported, except a country: `"conditions": { "Country": [...] }` instead of `has` on `x-vercel-ip-country` |
| `headers[].source`, `headers: [{ key, value }]`   | `for`, `values: { key: value }`                                                                                 |
| `rewrites` to `/index.html` from `/(.*)`          | The [SPA mode](#spa-mode) redirect                                                                              |
| `trailingSlash: true` / `false` / unset           | `trailingSlash: "always"` / `"never"` / `"ignore"`                                                              |
| `cleanUrls`                                       | Not supported: a storage zone can't serve `/about.html` at `/about`                                             |
| `outputDirectory`                                 | `outputDir`                                                                                                     |

## Trailing slashes

bunny.net serves `guides/index.html` at both `/guides` and `/guides/`. At `/guides`, relative links such as `./intro.html` resolve to `/intro.html` and break. Set `trailingSlash` in `orbitpush.json` to pick one form:

- `always` (default): a path whose last segment has no file extension, such as `/guides`, redirects with `301` to `/guides/`. Only HTML responses redirect, so files without an extension, such as `.well-known/apple-app-site-association`, are served as they are. Like Netlify's Pretty URLs, except that `/about.html` is not served at `/about/`: a storage zone can't serve another path. A missing path such as `/nope` redirects to `/nope/` and then gets the 404.
- `never`: `/guides/` redirects with `301` to `/guides`, except when the URL has a query string.
- `ignore`: no redirect. This is the default in [SPA mode](#spa-mode), where client routes such as `/projects` have no directory.

The redirect drops the query string, like a redirect with a fixed target in `redirects`. It is an edge rule that orbitpush manages, and the entries in `redirects` run first.

## Caching

Browsers get `Cache-Control: public, max-age=0` for every file, so they check for a new version on every visit, as on Netlify, and a deploy shows up right away. bunny.net still caches every file at its edge until the next deploy purges it.

For files whose name changes with their content, such as the fingerprinted assets of most build tools, set a long cache time in `headers`:

```json
"headers": [
  { "for": "/assets/*", "values": { "Cache-Control": "public, max-age=31536000, immutable" } }
]
```

A `Cache-Control` from `headers` also applies to bunny.net's edge: with `max-age=0` or `no-cache`, every request for those files goes to the storage zone.

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
