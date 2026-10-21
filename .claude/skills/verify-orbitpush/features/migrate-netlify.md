# Migrate from Netlify

`orbitpush migrate-netlify` copies a Netlify site's rules into `orbitpush.json`: `_redirects` and `_headers` from the output directory, then `[[redirects]]` and `[[headers]]` from `netlify.toml` in the work dir. It sends no request to bunny.net.

## Sub-features

- `migrate-write` writes `redirects` and `headers`, `_redirects` before `netlify.toml`, and keeps every other field.
- `migrate-warn` warns about lines it can't copy (`_redirects:<line> not migrated`, Basic-Auth) and, as `deploy` will, about rules bunny.net can't serve, which it still writes.
- `migrate-refuse` stops without writing when `orbitpush.json` already has rules, or when no source file exists.

## How to get to it (user POV)

- After `init`, run `orbitpush migrate-netlify` in a Netlify project. The Netlify files can stay.

## Driving it with ctl.sh

Preconditions:

- `init` with `--name verify-m --dir public --yes` exited `0`. Write a `public/_redirects` with `/old /about.html` and `/app/* /app/index.html 200`, and a `netlify.toml` with one `[[redirects]]` (`from = "/a"`, `to = "/b"`, `status = 302`) and one `[[headers]]` with a multi-line `cache-control` and a `Basic-Auth` value.

- **Migrate.** Run `$C cli $RUN migrate -- migrate-netlify`. Exit `0`. stderr warns `netlify.toml headers.0.values.Basic-Auth not migrated` and `redirects.1 skipped (status 200 ...)`. `orbitpush.json` has three redirects, `/old`, `/app/*`, `/a` in that order, one headers entry with a one-line `cache-control`, and no password. `bunny-state.json` has no new request.
- **Again.** Run it again: exit `1`, `already has redirects or headers`, file unchanged.
- **Deploy.** Run `deploy` with `public/_redirects` still there: exit `0`, stderr warns `_redirects is not read`, no `PUT` for `_redirects`, and `Updating edge rules` adds `/old` and `/a` but not `/app/*`.

## Gotchas

- `_redirects` and `_headers` are read from `outputDir`, which is often the build output. In a real project they live in the source (`static/`, `public/`) and the build copies them, so migrate after a build.
