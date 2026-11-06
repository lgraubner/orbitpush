# Deploy

`orbitpush deploy` uploads the files of the output directory that differ from the storage zone, applies the settings and edge rules, then deletes stale files and purges the cache. A rerun with nothing changed uploads nothing.

## Sub-features

- `deploy-setup` in a terminal without `orbitpush.json` asks `No orbitpush.json here. Set up a new site on bunny.net now?`, runs the init prompts (the output directory must exist) and deploys, ending with ``Use your own domain: `npx orbitpush domains add www.example.com` `` instead of init's `Next:` list. Declining exits `1`, Ctrl-C `130`, both without creating anything. Without a terminal it exits `1` with no prompt. Drive it with `$C tui $RUN <step> -- deploy`.
- `deploy-upload` uploads only files whose SHA256 checksum differs, HTML last. A symlinked file is uploaded with its target's content; a symlinked directory (`<path> links to a directory, which deploy does not follow. Copy it instead.`) and a broken symlink (`<path> links to a file that does not exist, so deploy skips it.`) are skipped with a warning. Without an `index.html` in the output it warns `No index.html in <dir>` and deploys.
- `deploy-stale` keeps files that are no longer in the output directory for 7 days, then deletes them, after the upload and the edge rule sync. The date each went stale is in the stale record `.orbitpush/stale.json` in the storage zone, which is never itself stale. The summary line counts them as `kept` while they wait. A file under `.orbitpush/` in the output directory is skipped with `<path> is not uploaded: .orbitpush/ in the storage zone belongs to orbitpush.`
- `deploy-purge` purges the pull zone cache once per deploy.
- `deploy-noop` uploads nothing and deletes nothing when nothing changed. It still re-sends the settings and rewrites every managed edge rule.
- `deploy-netlify-files` neither reads nor uploads `_redirects` and `_headers` in the root of the output directory, and warns about each. The warning suggests `orbitpush migrate-netlify` only while `orbitpush.json` has no `redirects` and no `headers`.
- `deploy-safe-fail` stops before any write when the output directory cannot be read. A failed upload stops before the stale delete and the purge, and no further upload starts. A request that never answers fails after 120 s; an upload gets 120 s plus 1 ms per 100 bytes.

## How to get to it (user POV)

- Run `orbitpush deploy` in the project directory after a build, with `BUNNY_API_KEY` set (locally or in CI).

## Driving it with ctl.sh

Preconditions:

- `$C cli $RUN init -- init --name verify-d --dir public --yes` exited `0`, then the fixture rules were merged: `jq -s '.[0] + .[1]' orbitpush.json rules.json > o.json && mv o.json orbitpush.json` in the work dir.

- **First deploy.** Run `$C cli $RUN deploy-1 -- deploy`. Exit `0`. stderr starts with `› Deploying public to https://verify-d.b-cdn.net`, `Project    verify-d (DE)` and `bunny.net  https://dash.bunny.net/cdn/1001` (labels are padded to the widest; `Storage zone` and `Pull zone` lines replace `Project` only when the zone names differ from `name`, and an `Aliases` line appears with aliases), then has the three fixture `redirects` warnings, `Files: 4 uploaded`, `Edge rules: 6 added`, and `✔ Deployed to https://verify-d.b-cdn.net in <n>s`. Without a TTY no progress line (`Comparing with storage zone`, `Uploading <n> of <m> files`, `Applying settings`, `Updating edge rules`, `Deleting <n> stale files`, `Purging cache`) is printed. In the summary's `writes`, the `PUT` of `assets/app.js` comes before the HTML files. `$C summary $RUN deploy-1` lists `404.html`, `about.html`, `assets/app.js`, `index.html`, with `purges: 1`.
- **Change and remove.** Edit `public/index.html`, delete `public/about.html`, then run `$C cli $RUN deploy-2 -- deploy`. stderr shows `Files: 1 uploaded, 1 kept, 2 unchanged`, without naming the files. In the summary's `writes`, the `PUT .../index.html` comes before `PUT .../.orbitpush/stale.json`, which comes before the purge. `about.html` is still stored and `purges` is `2`.
- **Stale file expires.** Drive the deploys with `FAKE_BUNNY_NOW=<date>` before `--`. After `about.html` went stale, a deploy 6 days 23 hours later shows `Files: 1 kept, ...` and writes no record; one 7 days 1 hour later shows `Files: 1 deleted, ...`, and its `writes` have `DELETE .../about.html`, then `PUT .../.orbitpush/stale.json`, then the purge. The record in `bunny-state.json` (base64 `Body`) ends as `{"version":1,"stale":{}}`.
- **No-op.** Run `$C cli $RUN deploy-3 -- deploy`. stderr has `Files: 3 unchanged` and `Edge rules: 6 kept`. The summary's files and `EdgeRules` equal the previous ones; `purges` is `3`, and `writes` grew by the two settings POSTs, six `addOrUpdate` and the purge, with no PUT or DELETE.
- **Failed upload.** Add a line to `public/index.html` and a `public/stale.txt`, deploy, delete `stale.txt`, change `index.html` again, then run `$C cli $RUN deploy-fail FAKE_BUNNY_FAIL="PUT /verify-d/index.html" -- deploy`. Exit `1`, stderr `✖ PUT /index.html failed: ...`, and the request log ends with the `500 PUT`: no settings, rule, DELETE or purge request follows.
- **Netlify rule files.** Create `public/_redirects` with `/a /b` and `public/_headers` with `/*` and `  X: y`. Run `$C cli $RUN deploy-4 -- deploy`. Exit `0`, stderr `_redirects is not read: its rules live in orbitpush.json.` and the same for `_headers`, without the `migrate-netlify` hint because the merged fixture rules are in `orbitpush.json`. No `PUT` for either file in the request log, and no edge rule for `/a`. Delete both files again.
- **Symlinks.** In `public/`, run `ln -s index.html link.html; ln -s assets dirlink; ln -s nope.html broken.html`, deploy: exit `0`, the `dirlink` and `broken.html` warnings, `Files: 1 uploaded, 3 unchanged`, and the summary stores `link.html` but no `dirlink/` or `broken.html`. Remove the three links.
- **No index.html.** Rename `public/index.html` and deploy: exit `0` and `! No index.html in public`. Rename it back.
- **Missing output dir.** Set `"outputDir": "missing"` in `orbitpush.json` and deploy. Exit `1`, stderr `Output directory "missing" not found. Did you run the build?`, and no new write (only the two zone GETs). With `"outputDir": "public/404.html"` it fails with `ENOTDIR: not a directory, scandir 'public/404.html'`, also without a write.
- **Set up.** In a fresh run, `$C tui $RUN setup -- deploy`, then `Enter`, `C-u verify-s Enter` and `Enter` four times: the screen shows the init lines, the deploy header, `Files: 4 uploaded`, `✔ Deployed to https://verify-s.b-cdn.net`, the `domains add` hint and `[orbitpush exited 0]`. `n Enter` instead ends with `[orbitpush exited 1]`, and `C-c` with `130`; neither writes `bunny-state.json`.

## Gotchas

- The fake compares the `Checksum` header with the body like bunny.net does. A `400 Checksum mismatch` means the CLI sent a wrong checksum, not a fake bug.
- `FAKE_BUNNY_FAIL` fails one exact path and the fake answers at once, so offline cannot show that no further upload starts after a failure, nor the request timeout. `test/deploy.test.ts` covers both.
- `deploy` re-applies settings and domains every time, so the SSL warning repeats on each deploy until the certificate succeeds.
