# Init

`orbitpush init` asks for the project settings or takes them from flags. It creates a storage zone and a pull zone named after the project, adds the custom domains, and writes `orbitpush.json`. If anything fails before `orbitpush.json` exists, it deletes the zones it created.

## Sub-features

- `init-prompts` runs the interactive questions with their defaults.
- `init-flags` uses flags and `--yes` without prompts.
- `init-config` writes `orbitpush.json` with the IDs of the created zones.
- `init-domain` adds the custom domain and its aliases, requests SSL, and prints the DNS record to create for each (`! Create this DNS record at your DNS provider:` and `<host> CNAME <name>.b-cdn.net`). init never shows the SSL warning for a hostname it just added. An alias without a domain fails with `Invalid --alias: aliases need a domain to redirect to` before any request, and a domain or alias that is not a hostname (`https://www.example.com`) with `Invalid --domain` or `Invalid --alias` before any request.
- `init-exists` refuses to run when `orbitpush.json` already exists.
- `init-rollback` deletes the created zones when a later step fails before the config is written.

## How to get to it (user POV)

- Run `orbitpush init` in a terminal and answer the prompts.
- Run `orbitpush init --name <n> --dir <d> [--domain <host>] [--alias <host>]... [--region <code>] [--replication-region <code>]... [--delivery-region <zone>]... --yes` in CI or a script. Every prompt has a flag, except the API key prompt, which appears only in a terminal without `BUNNY_API_KEY`.
- Run `orbitpush init` without a TTY or with `CI` set to anything but `false` or `0`: prompts are skipped and defaults are used. Without `BUNNY_API_KEY` it then fails.

## Driving it with ctl.sh

Preconditions:

- Fresh run after `launch` and `doctor`; no `orbitpush.json` in the work dir.

- **Prompts.** Run `$C tui $RUN init -- init`. The questions appear in this order: `Project name (used for storage zone and pull zone)` (default `site`), `Build output directory` (the first of `dist`, `build`, `out`, `public` that exists, else `dist`; `public` in the fixture), `Custom domain (optional)`, `Aliases that redirect to <domain>, comma separated (optional)` (only after a domain), `Main storage region` (list, `DE` first), `Storage replication regions (cannot be removed later)` (checkbox without the main region: `UK`, `SE`, `NY`, ...), `CDN delivery regions` (checkbox, `EU` and `US` checked). Answer with `$C keys $RUN C-u verify-a Enter`, `Enter`, `www.example.test Enter`, `Enter` (no alias), `Enter`, `Down Down Space Enter` (selects `NY`), `Enter`. Take a `$C screen` after each. The last screen shows `✔ Created orbitpush.json`, `! Create this DNS record at your DNS provider:` with `www.example.test CNAME verify-a.b-cdn.net`, `✔ Ready: https://verify-a.b-cdn.net`, ``Next: build your site, then run `npx orbitpush deploy` ``, and `[orbitpush exited 0]`.
- **Flags.** Run `$C cli $RUN init -- init --name verify-b --dir public --domain www.example.test --alias example.test --region NY --yes`. Exit `0`, and no prompt text in stderr.
- **Config.** Read `$TMPDIR/orbitpush-verify/$RUN/site/orbitpush.json`. It has `$schema`, the answers, `aliases: []` without aliases, empty `redirects` and `headers`, `storageZoneId` and `pullZoneId`. `domain` is left out when none was given. `$C summary $RUN init` shows the same IDs with matching names; the pull zone has `OriginType` `2` and `StorageZoneId` set to the storage zone's ID.
- **Domain.** The summary lists `www.example.test` among the pull zone `Hostnames` with `HasCertificate: false`. Repeat with `FAKE_BUNNY_CERT=ok` before `--` in a fresh run: the DNS-record hint still shows, and the hostname has `HasCertificate: true` and `ForceSSL: true`, with one `setForceSSL` write per custom hostname.
- **Exists.** Run init again in the same work dir. Exit `1`, stderr `orbitpush.json already exists.`, and no new requests in `bunny-state.json`.
- **Rollback.** In a fresh run, run `$C cli $RUN init -- init --name verify-c --dir public --yes` after `chmod 555 $TMPDIR/orbitpush-verify/$RUN/site`. Exit `1`. The writes in the summary end with `DELETE .../pullzone/1001` and `DELETE .../storagezone/1000`, both zones are gone, and there is no `orbitpush.json`. Run `chmod 755` on the work dir before cleanup. Also: run init with `FAKE_BUNNY_FAIL="POST /pullzone"`. The storage zone is created and then deleted.

## Gotchas

- The run's state file is shared by every step of a run. A second init with a taken name in a fresh work dir of the same run fails with `✖ POST /storagezone failed: The storage zone name is already taken (HTTP 400)`; in the same work dir it stops earlier, at `orbitpush.json already exists.` Use a new name or a new run.
- The replication checkbox omits the main region, so the arrow count for `NY` depends on the region picked before.
- The fake's SSL default fails, as for a domain whose DNS is not pointed yet. init hides that failure for hostnames it just added; the `No SSL certificate ... yet` warning appears from the next `deploy` on (`features/settings.md`).
- A hard kill during zone creation (not an error) skips the rollback. That path is not covered by any recipe.
