# Availability

`orbitpush disable` takes a site offline with an `orbitpush disabled` block rule on the pull zone and purges the cache; `orbitpush enable` removes it. `orbitpush destroy` deletes the pull zone, the storage zone and `orbitpush.json`.

## Sub-features

- `disable` adds one `orbitpush disabled` rule (ActionType 4, matching every URL) and purges. Run twice, the second run sends no write.
- `deploy` while disabled keeps the rule, warns `The site is disabled`, and deploys as usual.
- `enable` deletes every `orbitpush disabled` rule and purges. Run twice, the second run sends no write.
- `destroy` without `--yes` and without a terminal exits `1` before any request. On a terminal it asks to type the project name; Ctrl-C exits `130`. With `--yes` it deletes the pull zone, then the storage zone, then `orbitpush.json`.
- `destroy` again after both zones are gone gets two 404s and exits `0`.
- `destroy` stops at the first delete that fails with anything but 404, with exit `1`, and keeps the storage zone and `orbitpush.json` for a retry.
- All three need `BUNNY_API_KEY` and `orbitpush.json`, with the same errors as `deploy` (`features/cli-basics.md`).

## How to get to it (user POV)

- `npx orbitpush disable`, `npx orbitpush enable`, `npx orbitpush destroy [--yes]` in a project with `orbitpush.json`.

## Driving it with ctl.sh

Preconditions:

- `init` with `--name verify-a --dir public --yes` exited `0`, and a first `deploy` exited `0`.

- **Disable.** `$C cli $RUN disable-1 -- disable`, then again as `disable-2`. `bunny-state.json` `requests[]` holds one `addOrUpdate` with `Description: "orbitpush disabled"`.
- **Deploy while disabled.** `deploy` exits `0`, stderr warns, and no `DELETE .../edgerules/<guid>` follows.
- **Enable.** `$C cli $RUN enable-1 -- enable`, then `enable-2`: one edge rule DELETE in total.
- **Destroy.** `destroy` without flags exits `1`. Copy `orbitpush.json` from the work dir into the evidence dir. Run `$C tui $RUN destroy-tui -- destroy`, type `wrong Enter`: the screen shows `Type verify-a to confirm`; `C-c` ends with `[orbitpush exited 130]` and no request. Run `destroy --yes`: exit `0`, two DELETEs with `204`, the summary has no zones, `orbitpush.json` is gone. Copy the file back and run `destroy -y`: two DELETEs with `404`, exit `0`, and the same `✔ Deleted` line.
- **Destroy failure.** In a fresh run after `init`, run `$C cli $RUN destroy-fail FAKE_BUNNY_FAIL="DELETE /pullzone/1001" -- destroy --yes`. Exit `1`, stderr `✖ DELETE /pullzone/1001 failed: ...`, the request log ends with that `500` and no `DELETE /storagezone`, and `orbitpush.json` is still there.
- **Destroy confirmed.** Then run `$C tui $RUN destroy-ok -- destroy` and `$C keys $RUN verify-a Enter`. The screen shows `✔ Deleted verify-a from bunny.net and removed orbitpush.json` and `[orbitpush exited 0]`, with two `204` DELETEs.
- **No key or config.** In a fresh run before `init`, run `disable`, `enable` and `destroy` with `$C cli`, then again with `BUNNY_API_KEY=` before `--`. Each exits `1` with `orbitpush.json not found. Run \`orbitpush init\` first.`or`BUNNY_API_KEY is not set. ...`.
- **Live.** After an approved live `disable`: `curl -sS -o /dev/null -w '%{http_code}' https://verify-$RUN.b-cdn.net/` gives `403`; after `enable`, `200`. After `destroy`, the dashboard shows no `verify-$RUN` zones.

## Gotchas

- Run each step as its own `$C cli` line. A zsh loop over `"step command"` strings does not split words and runs the CLI without a command.
- Offline proves the requests. That bunny.net blocks cached responses and custom hostnames, and that deleting zones leaves nothing behind, shows only live.
