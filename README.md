# orbitpush

Deploy a static site or SPA to **your own** [bunny.net](https://bunny.net) account: a storage zone with a pull zone in front. No server, no platform, bring your own key.

```bash
export BUNNY_API_KEY=...   # https://dash.bunny.net/account/api-key
npx orbitpush init         # creates storage zone + pull zone, writes orbitpush.json
npm run build
npx orbitpush deploy       # uploads, syncs edge rules, purges the cache
```

## `orbitpush init`

Asks for the project name, build output directory, SPA mode, custom domains, the main storage region, replication regions and CDN delivery regions. Then it creates:

1. a storage zone (name = project name),
2. a pull zone with the storage zone as its origin (available at `https://<name>.b-cdn.net`),
3. the custom hostnames, and requests a free SSL certificate for them.

For a custom domain, point a `CNAME` record to `<name>.b-cdn.net`. For an apex domain (`example.com`) you need a DNS provider that supports `ALIAS`/CNAME flattening. If DNS is not set up yet, the certificate is requested again on every deploy until it works.

Each prompt can be skipped with a flag. Use `--yes` for non-interactive setup:

```bash
npx orbitpush init --name my-site --dir dist --spa --domain www.example.com --region DE --yes
```

The pull zone and storage zone names are global across bunny.net. If the name is taken, choose another one.

If `init` fails before `orbitpush.json` is written, it deletes the zones it just created, so you can run it again with the same name. If that cleanup fails too, `init` names the zone to delete in the dashboard. Failures after that point, such as a missing SSL certificate, are fixed by the next deploy.

## `orbitpush deploy`

1. Reads `orbitpush.json`, `BUNNY_API_KEY` and the rule files. A missing `_headers` or `_redirects` means no rules of that kind. A rule file that exists but cannot be read stops the deploy before anything changes.
2. Compares the output directory with the storage zone using SHA256 checksums and uploads only changed files, HTML files last.
3. Applies the settings from `orbitpush.json`: SPA/404 handling, replication regions, delivery regions and domains.
4. Turns `_headers` and `_redirects` into edge rules (see below).
5. Deletes files from the storage zone that are no longer in the build.
6. Purges the pull zone cache.

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
  "spa": false,
  "domains": ["www.example.com"],
  "region": "DE",
  "replicationRegions": ["NY"],
  "geoZones": ["EU", "US"],
  "storageZoneId": 123456,
  "pullZoneId": 654321
}
```

Settings are applied on every deploy, so you can change them later:

| Field                | Notes                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------- |
| `outputDir`          | Directory that gets deployed.                                                           |
| `spa`                | `true`: unknown paths without a file extension return `/index.html` with status 200.    |
| `domains`            | New hostnames are added with SSL. Removed hostnames are **not** removed from bunny.net. |
| `region`             | Main storage region. Fixed after `init`.                                                |
| `replicationRegions` | Can only be added. bunny.net does not support removing replication regions.             |
| `geoZones`           | CDN delivery regions: `EU`, `US`, `ASIA`, `SA`, `AF`. At least one.                     |

### 404 page

If `spa` is `false` and the output contains `404.html`, it is served for missing files. In SPA mode, `index.html` takes this role.

## `_headers` and `_redirects`

Both files use the [Netlify format](https://docs.netlify.com/manage/routing/redirects/overview/) and are read from the root of the output directory. They are not uploaded. Each redirect and each `_headers` path block becomes one edge rule.

Rules created by orbitpush have a description that starts with `orbitpush <hash>`. On deploy, new or changed rules are added and rules that no longer exist in the files are deleted. Edge rules you create yourself in the dashboard are never touched.

Unsupported lines print a warning and are skipped. They do not fail the deploy.

### Supported

```
# _redirects
/old            /new
/blog/:year/:id /posts/:year/:id   302
/docs/*         https://docs.example.com/:splat   302
https://example.com/*  https://www.example.com/:splat  301!
```

- Status codes `301` (default) and `302`, with or without `!`. bunny.net serves no other redirect code, so `303` and `307` are sent as `302` and `308` as `301`, with a warning
- Placeholders (`:name`) as whole path segments, and `*` / `:splat` as the last segment
- Absolute source URLs to redirect a single hostname
- `Country=` conditions with two-letter country codes (`/ /uk 302 Country=gb,ie`). Several `Country=` conditions on one line match any of their countries
- Matching with and without a trailing slash
- Rule order: if several redirects match a URL, the first one in the file wins, as on Netlify
- A relative target (`/new`) redirects on the hostname that was requested

```
# _headers
/*
  X-Frame-Options: DENY
/assets/*
  Cache-Control: public, max-age=31536000, immutable
```

- Any response header, placeholders and `*` work like in `_redirects`
- Repeated headers are joined with `, `
- If several path blocks set the same header for a URL, the last block in the file wins, as on Netlify

### Not supported

- **Rewrites and proxies (status `200`).** A storage zone can't serve another path internally. `/* /index.html 200` is recognised; set `"spa": true` instead.
- **Custom status pages (`404`, `410`, …)** for individual paths. Only the global 404 page is supported.
- **Shadowing.** On Netlify, a redirect without `!` only applies if no file exists at the path. Edge rules run before the storage zone is asked, so every redirect behaves as if it had `!`.
- **Query parameter matching** (`/store id=:id /product/:id`) and the conditions `Language=`, `Role=` and `Cookie=`.
- **Query strings are not passed on to redirect targets.**
- **`*` in the middle of a path or inside a segment** (`/a/*/b`, `/file-*.js`).
- **Placeholders inside a segment** (`/a-:id`). Placeholders must be a whole segment.
- **Header removal** (`! Header` from the Cloudflare format) and `netlify.toml`.

## Development

```bash
npm install            # also installs the lefthook git hooks
npm test               # vitest, no network
npm run format         # oxfmt
npm run lint           # oxlint with type-aware rules
npm run build          # type-checks and bundles everything into dist/cli.js (no runtime dependencies)
npm run check          # format check, lint, build and tests: must pass before a change is done
```

Dependencies are pinned to exact versions. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`type(scope): subject`); a lefthook `commit-msg` hook runs commitlint and rejects other messages.

## License

MIT
