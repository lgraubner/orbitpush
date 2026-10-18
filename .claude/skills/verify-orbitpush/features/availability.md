# Availability

`orbitpush disable` takes a site offline with an `orbitpush disabled` block rule on the pull zone and purges the cache; `orbitpush enable` removes it. `orbitpush destroy` deletes the pull zone, the storage zone and `orbitpush.json`.

## Sub-features

- `disable` adds one `orbitpush disabled` rule (ActionType 4, matching every URL) and purges. Run twice, the second run sends no write.
- `deploy` while disabled keeps the rule, warns `The site is disabled`, and deploys as usual.
- `enable` deletes every `orbitpush disabled` rule and purges. Run twice, the second run sends no write.
- `destroy` without `--yes` and without a terminal exits `1` before any request. With `--yes` it deletes the pull zone, then the storage zone, then `orbitpush.json`.
- `destroy` again after both zones are gone gets two 404s and exits `0`.

## How to get to it (user POV)

- `npx orbitpush disable`, `npx orbitpush enable`, `npx orbitpush destroy [--yes]` in a project with `orbitpush.json`.

## Driving it with ctl.sh

Preconditions:

- `init` with `--name verify-a --dir public --yes` exited `0`, and a first `deploy` exited `0`.

- **Disable.** `$C cli $RUN disable-1 -- disable`, then again as `disable-2`. `bunny-state.json` `requests[]` holds one `addOrUpdate` with `Description: "orbitpush disabled"`.
- **Deploy while disabled.** `deploy` exits `0`, stderr warns, and no `DELETE .../edgerules/<guid>` follows.
- **Enable.** `$C cli $RUN enable-1 -- enable`, then `enable-2`: one edge rule DELETE in total.
- **Destroy.** `destroy` without flags exits `1`. Copy `orbitpush.json` into the evidence dir, run `destroy --yes`: exit `0`, two DELETEs with `204`, the summary has no zones, `orbitpush.json` is gone. Copy the file back and run `destroy --yes` again: two DELETEs with `404`, exit `0`.
- **Live.** After an approved live `disable`: `curl -sS -o /dev/null -w '%{http_code}' https://verify-$RUN.b-cdn.net/` gives `403`; after `enable`, `200`. After `destroy`, the dashboard shows no `verify-$RUN` zones.

## Gotchas

- Run each step as its own `$C cli` line. A zsh loop over `"step command"` strings does not split words and runs the CLI without a command.
- Offline proves the requests. That bunny.net blocks cached responses and custom hostnames, and that deleting zones leaves nothing behind, shows only live.
