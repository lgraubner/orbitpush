# Init

`orbitpush init` asks for the project settings or takes them from flags. It creates a storage zone and a pull zone named after the project, adds the custom domains, and writes `orbitpush.json`. If anything fails before `orbitpush.json` exists, it deletes the zones it created.

## Sub-features

- `init-prompts` runs the interactive questions with their defaults.
- `init-flags` uses flags and `--yes` without prompts.
- `init-config` writes `orbitpush.json` with the IDs of the created zones.
- `init-domain` adds custom hostnames and requests SSL, warning when DNS is not ready.
- `init-exists` refuses to run when `orbitpush.json` already exists.
- `init-rollback` deletes the created zones when a later step fails before the config is written.

## How to get to it (user POV)

- Run `orbitpush init` in a terminal and answer the prompts.
- Run `orbitpush init --name <n> --dir <d> [--spa] [--domain <host>] [--region <code>] --yes` in CI or a script.
- Run `orbitpush init` without a TTY or with `CI` set: prompts are skipped and defaults are used.

## Driving it with ctl.sh

Preconditions:

- Fresh run after `launch` and `doctor`; no `orbitpush.json` in the work dir.

- **Prompts.** Run `$C tui $RUN init -- init`. The questions appear in this order: `Project name (used for storage zone and pull zone)` (default `site`), `Build output directory` (default `public`, the first of `dist`, `build`, `out`, `public` that exists), `Single-page app (serve index.html for unknown paths)?`, `Custom domains, comma separated (optional)`, `Main storage region` (list, `DE` first), `Storage replication regions (cannot be removed later)` (checkbox without the main region: `UK`, `SE`, `NY`, ...), `CDN delivery regions` (checkbox, `EU` and `US` checked). Answer with `$C keys $RUN C-u verify-a Enter`, `Enter`, `y Enter`, `www.example.test Enter`, `Enter`, `Down Down Space Enter` (selects `NY`), `Enter`. Take a `$C screen` after each. The last screen shows `✔ Created orbitpush.json`, the SSL warning for `www.example.test`, `✔ Ready: https://verify-a.b-cdn.net`, and `[orbitpush exited 0]`.
- **Flags.** Run `$C cli $RUN init -- init --name verify-b --dir public --spa --domain www.example.test --region NY --yes`. Exit `0`, and no prompt text in stderr.
- **Config.** Read `$TMPDIR/orbitpush-verify/$RUN/site/orbitpush.json`. It has `$schema`, the answers, `storageZoneId` and `pullZoneId`. `$C summary $RUN init` shows the same IDs with matching names; the pull zone has `OriginType` `2` and `StorageZoneId` set to the storage zone's ID.
- **Domain.** The summary lists `www.example.test` among the pull zone `Hostnames` with `HasCertificate: false`. Repeat with `FAKE_BUNNY_CERT=ok` before `--` in a fresh run: no warning, and the hostname has `HasCertificate: true` and `ForceSSL: true`.
- **Exists.** Run init again in the same work dir. Exit `1`, stderr `orbitpush.json already exists.`, and no new requests in `bunny-state.json`.
- **Rollback.** In a fresh run, run `$C cli $RUN init -- init --name verify-c --dir public --yes` after `chmod 555 $TMPDIR/orbitpush-verify/$RUN/site`. Exit `1`. The writes in the summary end with `DELETE .../pullzone/1001` and `DELETE .../storagezone/1000`, both zones are gone, and there is no `orbitpush.json`. Run `chmod 755` on the work dir before cleanup. Also: run init with `FAKE_BUNNY_FAIL="POST /pullzone"`. The storage zone is created and then deleted.

## Gotchas

- The run's state file is shared by every step of a run, so a second init with the same name answers `The pull zone name is already taken` / `The storage zone name is already taken`. Use a new name or a new run.
- `--spa` and `--no-spa` both skip the SPA prompt. Without either, the prompt is shown.
- The replication checkbox omits the main region, so the arrow count for `NY` depends on the region picked before.
- The fake's SSL default fails, as for a domain whose DNS is not pointed yet. The warning is expected unless `FAKE_BUNNY_CERT=ok` is set.
- A hard kill during zone creation (not an error) skips the rollback. That path is not covered by any recipe.
