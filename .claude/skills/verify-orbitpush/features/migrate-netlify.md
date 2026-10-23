# Migrate from Netlify

`orbitpush migrate-netlify` copies a Netlify site's rules into `orbitpush.json`: `_redirects` and `_headers` from the output directory, then `[[redirects]]` and `[[headers]]` from `netlify.toml` in the work dir. It sends no request to bunny.net.

## Sub-features

- `migrate-write` writes `redirects` and `headers`: `_redirects` before the `[[redirects]]` of `netlify.toml`, `_headers` before its `[[headers]]`. It rewrites `orbitpush.json` in the format `init` writes, so the fields `init` wrote stay the same.
- `migrate-warn` warns about what it can't copy (`_redirects:<line> not migrated (...)`, `_headers:<line> not migrated (Basic-Auth is not supported)`, `netlify.toml headers.<i>.values.Basic-Auth not migrated`, a `netlify.toml` redirect without `to`), then prints `✔ Wrote N redirects and M headers entries to orbitpush.json` and, under `› Deploy will skip what bunny.net can't serve:`, the warnings `deploy` will print. Those rules are still written. Passwords never reach the file or the output.
- `migrate-refuse` exits `1` without writing when `orbitpush.json` is missing, already has rules, when no source file exists (`Nothing to migrate: ...`), or when `netlify.toml` is invalid (`Invalid netlify.toml: ...`).

## How to get to it (user POV)

- After `init`, run `orbitpush migrate-netlify` in a Netlify project. The Netlify files can stay: `deploy` skips them with a warning (`features/deploy.md`).

## Driving it with ctl.sh

Preconditions:

- Fresh run after `launch` and `doctor`.

- **No config.** Run `$C cli $RUN noconf -- migrate-netlify`. Exit `1`, `orbitpush.json not found`.
- **Nothing.** Run `init` with `--name verify-m --dir public --yes`, copy `orbitpush.json` to the evidence dir as `before.json`, then run `$C cli $RUN empty -- migrate-netlify`. Exit `1`, `Nothing to migrate: no netlify.toml here and no _redirects or _headers in public. If your build copies them there, build first.`
- **Migrate.** Write `public/_redirects` with `/old /about.html`, `/app/* /app/index.html 200` and `/broken`; `public/_headers` with `/*`, `  X-Frame-Options: DENY` and `  Basic-Auth: u:pw1`; and a `netlify.toml` with one `[[redirects]]` (`from = "/a"`, `to = "/b"`, `status = 302`) and one `[[headers]]` (`for = "/*"`, a multi-line `cache-control` of `max-age=0,` and `must-revalidate`, and `Basic-Auth = "u:pw2"`). Run `$C cli $RUN migrate -- migrate-netlify`. Exit `0`, no request in `bunny-state.json`, and stderr in this order: `_redirects:3 not migrated (missing target): /broken`, `_headers:3 not migrated (Basic-Auth is not supported)`, `netlify.toml headers.0.values.Basic-Auth not migrated (not supported)`, `✔ Wrote 3 redirects and 2 headers entries to orbitpush.json`, `› Deploy will skip what bunny.net can't serve:`, `redirects.1 skipped (status 200 is not supported, only redirects): /app/* /app/index.html`. `orbitpush.json` has the redirects `/old` (301), `/app/*` (200), `/a` (302), the headers `{X-Frame-Options: DENY}` and `{cache-control: "max-age=0, must-revalidate"}`, neither password, and every other field equal to `before.json`.
- **Again.** Run it again: exit `1`, `already has redirects or headers. Empty both to migrate again.`, file byte-identical.
- **Deploy.** Run `deploy` with the Netlify files still there: exit `0`, `_redirects is not read: its rules live in orbitpush.json.` and the same for `_headers`, without the `migrate-netlify` hint, `Edge rules: 5 added` (`/old`, `/a`, two headers rules, trailing slash), no rule for `/app/*`, and no `PUT` for `_redirects`, `_headers` or `netlify.toml`.

## Gotchas

- `_redirects` and `_headers` are read from `outputDir`, which is often the build output. In a real project they live in the source (`static/`, `public/`) and the build copies them, so migrate after a build.
