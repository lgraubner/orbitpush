# Deploy

`orbitpush deploy` uploads the files of the output directory that differ from the storage zone, applies the settings and edge rules, then deletes stale files and purges the cache. A rerun with nothing changed uploads nothing.

## Sub-features

- `deploy-setup` in a terminal without `orbitpush.json` asks `No orbitpush.json here. Set up a new site on bunny.net now?`, runs the init prompts (the output directory must exist) and deploys. Declining exits `1`, Ctrl-C `130`, both without creating anything. Without a terminal it exits `1` with no prompt. Drive it with `$C tui $RUN <step> -- deploy`.
- `deploy-upload` uploads only files whose SHA256 checksum differs, HTML last. A symlinked file is uploaded with its target's content; a symlinked directory is skipped with a warning.
- `deploy-stale` deletes files that are no longer in the output directory, after the upload.
- `deploy-purge` purges the pull zone cache once per deploy.
- `deploy-noop` uploads nothing and deletes nothing when nothing changed. It still re-sends the settings and rewrites every managed edge rule.
- `deploy-netlify-files` neither reads nor uploads `_redirects` and `_headers` in the root of the output directory, and warns about each. The warning suggests `orbitpush migrate-netlify` only while `orbitpush.json` has no `redirects` and no `headers`.
- `deploy-safe-fail` stops before any write when the output directory cannot be read. A failed upload stops before the stale delete and the purge, and no further upload starts. A request that never answers fails after 120 s (uploads have no limit).

## How to get to it (user POV)

- Run `orbitpush deploy` in the project directory after a build, with `BUNNY_API_KEY` set (locally or in CI).

## Driving it with ctl.sh

Preconditions:

- `$C cli $RUN init -- init --name verify-d --dir public --yes` exited `0`, then the fixture rules were merged: `jq -s '.[0] + .[1]' orbitpush.json rules.json > o.json && mv o.json orbitpush.json` in the work dir.

- **First deploy.** Run `$C cli $RUN deploy-1 -- deploy`. Exit `0`. stderr starts with `› Deploying public to https://verify-d.b-cdn.net` and `Project  verify-d (DE)` (separate storage zone and pull zone lines appear only when their names differ from `name`), then has the three fixture `redirects` warnings, `Files: 4 uploaded`, `Edge rules: 6 added`, and `✔ Deployed to https://verify-d.b-cdn.net in <n>s`. Without a TTY no progress line (`Comparing with storage zone`, `Applying settings`, `Purging cache`) is printed. In the summary's `writes`, the `PUT` of `assets/app.js` comes before the HTML files. `$C summary $RUN deploy-1` lists `404.html`, `about.html`, `assets/app.js`, `index.html`, with `purges: 1`.
- **Change and remove.** Edit `public/index.html`, delete `public/about.html`, then run `$C cli $RUN deploy-2 -- deploy`. stderr shows `Files: 1 uploaded, 1 deleted, 2 unchanged`, without naming the files. In the summary's `writes`, the `PUT .../index.html` comes before `DELETE .../about.html`, which comes before the purge. `about.html` is gone and `purges` is `2`.
- **No-op.** Run `$C cli $RUN deploy-3 -- deploy`. stderr has `Files: 3 unchanged` and `Edge rules: 6 kept`. The summary's files and `EdgeRules` equal the previous ones; `purges` is `3`, and `writes` grew by the two settings POSTs, six `addOrUpdate` and the purge, with no PUT or DELETE.
- **Failed upload.** Add a line to `public/index.html` and a `public/stale.txt`, deploy, delete `stale.txt`, change `index.html` again, then run `$C cli $RUN deploy-fail FAKE_BUNNY_FAIL="PUT /verify-d/index.html" -- deploy`. Exit `1`, stderr `✖ PUT /index.html failed: ...`, and the request log ends with the `500 PUT`: no settings, rule, DELETE or purge request follows.
- **Netlify rule files.** Create `public/_redirects` with `/a /b` and `public/_headers` with `/*` and `  X: y`. Run `$C cli $RUN deploy-4 -- deploy`. Exit `0`, stderr `_redirects is not read: its rules live in orbitpush.json.` and the same for `_headers`, without the `migrate-netlify` hint because the merged fixture rules are in `orbitpush.json`. No `PUT` for either file in the request log, and no edge rule for `/a`. Delete both files again.
- **Missing output dir.** Set `"outputDir": "missing"` in `orbitpush.json` and deploy. Exit `1`, stderr `Output directory "missing" not found. Did you run the build?`, and no new write.

## Gotchas

- The fake compares the `Checksum` header with the body like bunny.net does. A `400 Checksum mismatch` means the CLI sent a wrong checksum, not a fake bug.
- `deploy` re-applies settings and domains every time, so the SSL warning repeats on each deploy until the certificate succeeds.
