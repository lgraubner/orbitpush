# Init

`orbitpush init` asks for the project settings or takes them from flags. It creates a storage zone and a pull zone named after the project, adds the hostnames of `--domain` and `--alias`, and writes `orbitpush.json`. If anything fails before `orbitpush.json` exists, it deletes the zones it created.

## Sub-features

- `init-prompts` runs the interactive questions with their defaults.
- `init-flags` uses flags and `--yes` without prompts.
- `init-config` writes `orbitpush.json` with the IDs of the created zones.
- `init-domain` adds the hostnames of `--domain` and `--alias` (there is no domain prompt), requests SSL, and prints the DNS record to create for each (``! Add this DNS record, then run `orbitpush domains add <host>` to finish:`` and `<host> CNAME <name>.b-cdn.net`). init never shows the SSL warning for a hostname it just added. An alias without a domain fails with `Invalid --alias: aliases need a domain to redirect to` before any request, and a domain or alias that is not a hostname (`https://www.example.com`) with `Invalid --domain` or `Invalid --alias` before any request.
- `init-no-terminal` without a terminal and without `--yes` needs `--name` and `--dir`; otherwise it exits `1` with `Without a terminal, init needs --name and --dir, or --yes for the defaults (...)` before any request.
- `init-next` ends with `Next:`, step 1 (build, then `npx orbitpush deploy`) and step 2 (`npx orbitpush domains add www.example.com`, or with `--domain` ``Add the DNS records above, then run `npx orbitpush domains add <domain>` ``).
- `init-exists` refuses to run when `orbitpush.json` already exists.
- `init-rollback` deletes the created zones when a later step fails before the config is written.

## How to get to it (user POV)

- Run `orbitpush init` in a terminal and answer the prompts.
- Run `orbitpush init --name <n> --dir <d> [--domain <host>] [--alias <host>]... [--region <code>] [--replication-region <code>]... [--delivery-region <zone>]... --yes` in CI or a script. Every prompt has a flag, except the API key prompt, which appears only in a terminal without `BUNNY_API_KEY`.
- Run `orbitpush init` without a TTY or with `CI` set to anything but `false` or `0`: prompts are skipped. It then needs `--name` and `--dir`, or `--yes` for the defaults, and `BUNNY_API_KEY`.

## Driving it with ctl.sh

Preconditions:

- Fresh run after `launch` and `doctor`; no `orbitpush.json` in the work dir.
- Each init that succeeds leaves `orbitpush.json` behind, and the next init stops at `orbitpush.json already exists.` before any other check. Run **No terminal** first, and give **Prompts**, **Flags**, the second **Domain** run and **Rollback** a fresh run each.

- **No terminal.** Run `$C cli $RUN init-bare -- init`. Exit `1`, `Without a terminal, init needs --name and --dir`, and no `bunny-state.json` (no request). `--alias example.test` without `--domain` and `--domain https://www.example.com` also exit `1` before any request, with `Invalid --alias` and `Invalid --domain`.
- **Prompts.** Run `$C tui $RUN init -- init`. The questions appear in this order: `Project name (used for storage zone and pull zone)` (default `site`), `Build output directory` (the first of `dist`, `build`, `out`, `public` that exists, else `dist`; `public` in the fixture), `Main storage region` (list, `DE` first), `Storage replication regions (cannot be removed later)` (checkbox without the main region: `UK`, `SE`, `NY`, ...), `CDN delivery regions` (checkbox, `EU` and `US` checked). Answer with `$C keys $RUN C-u verify-a Enter`, `Enter`, `Enter`, `Down Down Space Enter` (selects `NY`), `Enter`. Take a `$C screen` after each. The last screen shows `✔ Created orbitpush.json`, `✔ Ready: https://verify-a.b-cdn.net`, `Next:` with the build-and-deploy step and `npx orbitpush domains add www.example.com`, and `[orbitpush exited 0]`. No question mentions a domain.
- **Flags.** Run `$C cli $RUN init -- init --name verify-b --dir public --domain www.example.test --alias example.test --region NY --yes`. Exit `0`, no prompt text in stderr, `✔ Created orbitpush.json` before `› Adding hostname www.example.test`, a DNS record hint per hostname (`example.test` adds `At the root of a domain, use ALIAS, ANAME or CNAME flattening instead of CNAME.`), and ``2. Add the DNS records above, then run `npx orbitpush domains add www.example.test` ``.
- **Config.** Read `$TMPDIR/orbitpush-verify/$RUN/site/orbitpush.json`. It has `$schema`, the answers, empty `redirects` and `headers`, `storageZoneId` and `pullZoneId`. After **Prompts** it has `aliases: []` and no `domain`; after **Flags**, `domain: www.example.test` and `aliases: ["example.test"]`. `$C summary $RUN init` shows the same IDs with matching names; the pull zone has `OriginType` `2` and `StorageZoneId` set to the storage zone's ID.
- **Domain.** The summary lists `www.example.test` among the pull zone `Hostnames` with `HasCertificate: false`. Repeat with `FAKE_BUNNY_CERT=ok` before `--` in a fresh run: the DNS-record hint still shows, and each custom hostname has `HasCertificate: true` and `ForceSSL: true`, with one `setForceSSL` write per custom hostname.
- **Exists.** Run init again in the work dir of a run where init succeeded. Exit `1`, stderr `orbitpush.json already exists.`, and no new requests in `bunny-state.json`.
- **Rollback.** In a fresh run, run `$C cli $RUN init -- init --name verify-c --dir public --yes` after `chmod 555 $TMPDIR/orbitpush-verify/$RUN/site`. Exit `1`. The writes in the summary end with `DELETE .../pullzone/1001` and `DELETE .../storagezone/1000`, both zones are gone, and there is no `orbitpush.json`. Run `chmod 755` on the work dir before cleanup. Also: run init with `FAKE_BUNNY_FAIL="POST /pullzone"`. The storage zone is created and then deleted.

## Gotchas

- The run's state file is shared by every step of a run. A second init with a taken name after `rm orbitpush.json` in the same run fails with `✖ POST /storagezone failed: The storage zone name is already taken (HTTP 400)`; in the same work dir it stops earlier, at `orbitpush.json already exists.` Use a new name or a new run.
- The replication checkbox omits the main region, so the arrow count for `NY` depends on the region picked before.
- The fake's SSL default fails, as for a domain whose DNS is not pointed yet. init hides that failure for hostnames it just added; the `DNS for ... does not point to bunny.net yet` warning appears from the next `deploy` on (`features/settings.md`).
- A hard kill during zone creation (not an error) skips the rollback. That path is not covered by any recipe.
