# Domains

`orbitpush domains add|remove|list` puts the site on the user's own hostnames. `add` and `remove` update `domain` and `aliases` in `orbitpush.json` together with the pull zone hostnames, certificates, Force SSL and the managed edge rules; `list` only reads.

## Sub-features

- `domains-add` adds the hostname to `orbitpush.json` (the first becomes `domain`, later ones `aliases`) and the pull zone, requests the certificate, sets Force SSL, sends `EnableHostnameVary: true`, syncs the edge rules and purges only when rules changed. Rerunning it for a connected hostname changes nothing on the pull zone.
- `domains-wait` while DNS is missing prints the record (plus an ALIAS/ANAME line for a two-label host). In a terminal it rechecks after 5, 10, 20, 40 s, then every 60 s for up to 15 min, as a status line; SIGINT prints `Stopped waiting. Run ... again` and exits `130`. Without a terminal it checks once and exits `1`.
- `domains-primary` (`add <host> --primary`) switches `domain` and `aliases` only once the host is connected; the former primary becomes the first alias and the old alias rule is deleted before the new one is written. If it does not connect, the host stays an alias.
- `domains-remove` removes the hostname from `orbitpush.json` and the pull zone and syncs the rules; it refuses a primary domain that still has aliases, and a hostname that is neither in the config nor on the pull zone.
- `domains-list` sends only GET requests and shows each hostname as connected, waiting for DNS (with the record), not added yet, or on the pull zone but not in `orbitpush.json`.

## How to get to it (user POV)

- Run `orbitpush domains add www.example.com` in the project directory after `init` or the first `deploy`, add the printed DNS record, and let it wait.

## Driving it with ctl.sh

Preconditions:

- `$C cli $RUN init -- init --name verify-m --dir public --yes` exited `0`.

Journeys:

- **DNS missing.** `$C cli $RUN a1 -- domains add www.example.test`: exit `1`, `Adding hostname www.example.test`, the record `www.example.test CNAME verify-m.b-cdn.net`, and `is not connected yet` with the rerun command. `orbitpush.json` has `"domain": "www.example.test"`.
- **Connect.** `$C cli $RUN a2 FAKE_BUNNY_CERT=ok -- domains add www.example.test`: exit `0`, `✔ www.example.test is connected: https://www.example.test`.
- **Alias.** `$C cli $RUN a3 FAKE_BUNNY_CERT=ok -- domains add example.test`: `✔ example.test is connected and redirects to www.example.test`; the pull zone has `orbitpush <hash> alias example.test www.example.test`.
- **List.** `$C cli $RUN l1 -- domains list`: both hostnames `connected`, no write in `writes`.
- **Primary.** `$C cli $RUN p1 FAKE_BUNNY_CERT=ok -- domains add example.test --primary`: `✔ example.test is now the primary domain. www.example.test redirects to it.`; `orbitpush.json` has `domain: example.test`, `aliases: ["www.example.test"]`; the alias rule is `alias www.example.test example.test`.
- **Remove.** `domains remove example.test` exits `1` (`has aliases that redirect to it`); `domains remove www.example.test` exits `0` with `Removing hostname www.example.test`.
- **Wait and stop.** The wait needs a terminal and stderr on it, so `TUI_STDERR=file` turns it off. Run the built CLI under `script -q <file> node --import fake-bunny.mjs dist/cli.js domains add example.org` (with `FAKE_BUNNY_STATE` and `BUNNY_API_KEY` set, `CI` unset), wait for `next check in`, then `pkill -INT -f "domains add example.org"`. Ctrl+C through `$C keys` ends the whole tmux session.

## Gotchas

- `FAKE_BUNNY_CERT` is read per process, so the fake cannot turn DNS on during one wait; the switch from waiting to connected is covered by `test/domains.test.ts` with fake timers.
- Only a live run proves that bunny.net issues the certificate once real DNS points to it. It needs the user's approval and a hostname whose DNS they control.
