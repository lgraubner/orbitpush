# Domains

`orbitpush domains add|remove|list` puts the site on the user's own hostnames. `add` and `remove` update `domain` and `aliases` in `orbitpush.json` together with the pull zone hostnames, certificates, Force SSL and the managed edge rules; `list` only reads.

## Sub-features

- `domains-add` adds the hostname to `orbitpush.json` (the first becomes `domain`, later ones `aliases`) and the pull zone, requests the certificate, sets Force SSL, sends `EnableHostnameVary: true`, syncs the edge rules and purges only when rules changed. Rerunning it for a connected hostname adds nothing: it sends `EnableHostnameVary: true`, rewrites the managed rules in place and does not purge. A host is lowercased; a non-hostname, two hostnames or a refused `addHostname` exit `1` without changing `orbitpush.json`.
- `domains-wait` while DNS is missing prints the record (plus an ALIAS/ANAME line for a two-label host). In a terminal it rechecks 10 s after each check for up to 15 min, as a status line; SIGINT prints `Stopped waiting. Run ... again` and exits `130`. Without a terminal it checks once and exits `1`.
- `domains-primary` (`add <host> --primary`) switches `domain` and `aliases` only once the host is connected; the former primary becomes the first alias and the old alias rule is deleted before the new one is written. If it does not connect, the host stays an alias.
- `domains-remove` removes the hostname from `orbitpush.json` and the pull zone and syncs the rules; it refuses a primary domain that still has aliases, and a hostname that is neither in the config nor on the pull zone.
- `domains-list` sends only GET requests and shows each hostname as connected, waiting for DNS (with the record), not added yet, or on the pull zone but not in `orbitpush.json`. It exits `1` while any domain is not connected, and prints `No domains yet. Add one with ...` without any.

## How to get to it (user POV)

- Run `orbitpush domains add www.example.com` in the project directory after `init` or the first `deploy`, add the printed DNS record, and let it wait.

## Driving it with ctl.sh

Preconditions:

- `$C cli $RUN init -- init --name verify-m --dir public --yes` exited `0`.

Journeys:

- **Refusals.** `domains add https://x` (`Invalid hostname`), `domains add a.test b.test` (`takes one hostname at a time`) and `$C cli $RUN r1 FAKE_BUNNY_FAIL="POST /pullzone/1001/addHostname" -- domains add www.example.test` each exit `1`; after `r1`, `orbitpush.json` still has no `domain`. `domains list` before any domain exits `0` with `No domains yet`.
- **DNS missing.** `$C cli $RUN a1 -- domains add WWW.example.test`: exit `1`, `Adding hostname www.example.test`, the record `www.example.test CNAME verify-m.b-cdn.net`, and `is not connected yet` with the rerun command. `orbitpush.json` has `"domain": "www.example.test"`, lowercased. `domains list` now exits `1` with `waiting for DNS: www.example.test CNAME verify-m.b-cdn.net`.
- **Connect.** `$C cli $RUN a2 FAKE_BUNNY_CERT=ok -- domains add www.example.test`: exit `0`, `✔ www.example.test is connected: https://www.example.test`.
- **Alias.** `$C cli $RUN a3 FAKE_BUNNY_CERT=ok -- domains add example.test`: `✔ example.test is connected and redirects to www.example.test`; the pull zone has `orbitpush <hash> alias example.test www.example.test`.
- **List.** `$C cli $RUN l1 -- domains list`: exit `0`, both hostnames `connected`, and the requests it added to `bunny-state.json` are one GET (compare `requests` length before and after; `writes` holds every earlier step's writes).
- **Primary.** `$C cli $RUN p1 FAKE_BUNNY_CERT=ok -- domains add example.test --primary`: `✔ example.test is now the primary domain. www.example.test redirects to it.`; `orbitpush.json` has `domain: example.test`, `aliases: ["www.example.test"]`; the alias rule is `alias www.example.test example.test`.
- **Remove.** `domains remove example.test` exits `1` (`has aliases that redirect to it`); `domains remove nope.example.test` exits `1` (`is not a domain of this site`); `domains remove www.example.test` exits `0` with `Removing hostname www.example.test` and `✔ Removed www.example.test. It no longer serves the site.`
- **Wait and stop.** The wait needs a terminal and stderr on it, so run it without `TUI_STDERR=file`: `$C tui $RUN w1 -- domains add wait.example.org`. The screen shows `Waiting for DNS, 1 check so far (Ctrl+C to stop), checking wait.example.org every 10s…` on one row, and about 10 s later the same row reads `2 checks so far`, with no new row above it; the request log gains one `loadFreeCertificate` request about every 10 s. Stop only this run's CLI: `P=$(tmux list-panes -t "=orbitpush-verify-$RUN" -F '#{pane_pid}'); kill -INT $(pgrep -P "$P" node)`. The screen shows ``! Stopped waiting. Run `orbitpush domains add wait.example.org` again once the record is set.`` and `[orbitpush exited 130]`.

## Gotchas

- `FAKE_BUNNY_CERT` is read per process, so the fake cannot turn DNS on during one wait; the switch from waiting to connected is covered by `test/domains.test.ts` with fake timers.
- Only a live run proves that bunny.net issues the certificate once real DNS points to it. It needs the user's approval and a hostname whose DNS they control.
- Measured live in run `l151407`: bunny.net's refusal for missing DNS contains `not pointing to our servers`, also for a hostname that a wildcard record resolves elsewhere. With the CNAME already set, `domains add` connected on the first check, without waiting, and the certificate took about 10 s inside that one request. For a few seconds after `connected`, the edge still served a certificate without the new hostname (`SSL: no alternative certificate subject name`). After `--primary`, the old redirect still applied 3 s later and the new one from 6 s on, with no loop seen at 3 s sampling. A removed hostname answers `403`. Use `curl --resolve <host>:443:<ip of <name>.b-cdn.net>` when the local resolver still caches an old answer.
