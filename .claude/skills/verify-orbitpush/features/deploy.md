# Deploy

`orbitpush deploy` uploads the files of the output directory that differ from the storage zone, applies the settings and edge rules, then deletes stale files and purges the cache. A rerun with nothing changed uploads nothing.

## Sub-features

- `deploy-upload` uploads only files whose SHA256 checksum differs, HTML last.
- `deploy-stale` deletes files that are no longer in the output directory, after the upload.
- `deploy-purge` purges the pull zone cache once per deploy.
- `deploy-noop` uploads nothing and deletes nothing when nothing changed. It still re-sends the settings and rewrites every managed edge rule.
- `deploy-safe-fail` stops before any write when the output directory or a rule file cannot be read. A failed upload stops before the stale delete and the purge.

## How to get to it (user POV)

- Run `orbitpush deploy` in the project directory after a build, with `BUNNY_API_KEY` set (locally or in CI).

## Driving it with ctl.sh

Preconditions:

- `$C cli $RUN init -- init --name verify-d --dir public --yes` exited `0`.

- **First deploy.** Run `$C cli $RUN deploy-1 -- deploy`. Exit `0`. stderr has the three fixture `_redirects` warnings, `Comparing with storage zone`, `Uploading 4 of 4 files` with the HTML files listed after `assets/app.js`, `Applying settings`, `Updating edge rules (+6 ~0 -0)`, `Purging cache` and `✔ Deployed`. `$C summary $RUN deploy-1` lists `404.html`, `about.html`, `assets/app.js`, `index.html` and no `_headers` or `_redirects`, with `purges: 1`.
- **Change and remove.** Edit `public/index.html`, delete `public/about.html`, then run `$C cli $RUN deploy-2 -- deploy`. stderr shows `Uploading 1 of 3 files` with `index.html` and `Deleting 1 stale files`. In the summary's `writes`, the `PUT .../index.html` comes before `DELETE .../about.html`, which comes before the purge. `about.html` is gone and `purges` is `2`.
- **No-op.** Run `$C cli $RUN deploy-3 -- deploy`. stderr has `Uploading 0 of 3 files`, `Updating edge rules (+0 ~6 -0)` and no `Deleting` line. The summary's files and `EdgeRules` equal the previous ones; `purges` is `3`, and `writes` grew by the two settings POSTs, six `addOrUpdate` and the purge, with no PUT or DELETE.
- **Failed upload.** Add a line to `public/index.html` and a `public/stale.txt`, deploy, delete `stale.txt`, change `index.html` again, then run `$C cli $RUN deploy-fail FAKE_BUNNY_FAIL="PUT /verify-d/index.html" -- deploy`. Exit `1`, stderr `✖ PUT /index.html failed: ...`, and the request log ends with the `500 PUT`: no settings, rule, DELETE or purge request follows.
- **Unreadable rule file.** Replace `public/_redirects` with a directory: `rm public/_redirects && mkdir public/_redirects`. Run `$C cli $RUN deploy-4 -- deploy`. Exit `1`, stderr names `EISDIR`, and `bunny-state.json` has no new non-GET request.
- **Missing output dir.** Set `"outputDir": "missing"` in `orbitpush.json` and deploy. Exit `1`, stderr `Output directory "missing" not found. Did you run the build?`, and no new write.

## Gotchas

- `Uploading N of M`: M counts files without `_headers` and `_redirects`.
- The fake compares the `Checksum` header with the body like bunny.net does. A `400 Checksum mismatch` means the CLI sent a wrong checksum, not a fake bug.
- `deploy` re-applies settings and domains every time, so the SSL warning repeats on each deploy until the certificate succeeds.
