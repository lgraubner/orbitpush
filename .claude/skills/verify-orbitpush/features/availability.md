# Availability

`orbitpush disable` takes a site offline with an `orbitpush disabled` block rule on the pull zone and purges the cache; `orbitpush enable` removes it. `orbitpush destroy` deletes the storage zone that the pull zone serves, then the pull zone, then `orbitpush.json`.

## Sub-features

- `disable` adds one `orbitpush disabled` rule (ActionType 4, matching every URL) and purges. Run twice, the second run prints `✔ <name> is already disabled` and sends no write, only the pull zone GET.
- `deploy` while disabled keeps the rule, warns `The site is disabled`, and deploys as usual.
- `enable` deletes every `orbitpush disabled` rule and purges. Run twice, the second run prints `✔ <name> is already enabled` and sends no write.
- `destroy` without `--yes` and without a terminal exits `1` before any request, with `destroy deletes the pull zone, storage zone and every file of <name>. Run it with --yes to confirm.` On a terminal, with `CI` unset, `false` or `0`, it asks to type the project name; Ctrl-C exits `130`. With `--yes` it reads the pull zone, deletes the storage zone named by its `StorageZoneId` (bunny.net deletes the pull zone along with it), then the pull zone, which counts a 404 as deleted, then `orbitpush.json`.
- `destroy` again after both zones are gone gets a 404 on the pull zone read, sends no DELETE and exits `0`.
- `destroy` stops at the first request that fails with anything but 404, with exit `1`, and keeps `orbitpush.json` for a retry. A pull zone that does not serve a storage zone stops it before any DELETE.
- All three need `BUNNY_API_KEY` and `orbitpush.json`, and check the key first. Without the config they always fail, also in a terminal, where `deploy` would offer setup instead (`features/cli-basics.md`).

## How to get to it (user POV)

- `npx orbitpush disable`, `npx orbitpush enable`, `npx orbitpush destroy [--yes]` in a project with `orbitpush.json`.

## Driving it with ctl.sh

Preconditions:

- `init` with `--name verify-a --dir public --yes` exited `0`, and a first `deploy` exited `0`.

- **Disable.** `$C cli $RUN disable-1 -- disable`, then again as `disable-2`. `bunny-state.json` `requests[]` holds one `addOrUpdate` with `Description: "orbitpush disabled"`.
- **Deploy while disabled.** `deploy` exits `0`, stderr warns, and no `DELETE .../edgerules/<guid>` follows.
- **Enable.** `$C cli $RUN enable-1 -- enable`, then `enable-2`: one edge rule DELETE in total.
- **Destroy.** `destroy` without flags exits `1` with `Run it with --yes to confirm.` Copy `orbitpush.json` from the work dir into the evidence dir. Run `$C tui $RUN destroy-tui -- destroy`, note `requests` length in `bunny-state.json`, type `wrong Enter`: a second `> Type verify-a to confirm` line appears under the prompt and the pane has no `[orbitpush exited` yet; `C-c` ends with `[orbitpush exited 130]` and the `requests` length is unchanged. Run `destroy --yes`: exit `0`, `› Deleting storage zone verify-a (1000) and every file in it`, `› Deleting pull zone verify-a (1001)`, `DELETE /storagezone/1000` with `204` and `DELETE /pullzone/1001` with `404` (the fake deletes it with the storage zone, as bunny.net does), the summary has no zones, `orbitpush.json` is gone. Copy the file back and run `destroy -y`: `GET /pullzone/1001` with `404`, no DELETE, exit `0`, and the same `✔ Deleted` line.
- **Destroy failure.** In a fresh run after `init`, run `$C cli $RUN destroy-fail FAKE_BUNNY_FAIL="DELETE /storagezone/1000" -- destroy --yes`. Exit `1`, stderr `✖ DELETE /storagezone/1000 failed: ...`, the request log ends with that `500` and no `DELETE /pullzone`, both zones are still in the summary, and `orbitpush.json` is still there.
- **Destroy confirmed.** Then run `$C tui $RUN destroy-ok -- destroy` and `$C keys $RUN verify-a Enter`. The screen shows `✔ Deleted verify-a from bunny.net and removed orbitpush.json` and `[orbitpush exited 0]`, with `DELETE /storagezone/1000` answered `204`.
- **No key or config.** In a fresh run before `init`, run `disable`, `enable` and `destroy` with `$C cli`, then again with `BUNNY_API_KEY=` before `--`. Each exits `1`: without the key with `BUNNY_API_KEY is not set. ...`, otherwise with ``orbitpush.json not found. Run `orbitpush init` first, or `orbitpush init --name <name> --dir <dir> --yes` without a terminal.``
- **Live.** After an approved live `disable`: `curl -sS -o /dev/null -w '%{http_code}' https://verify-$RUN.b-cdn.net/` gives `403`; after `enable`, `200`. After `destroy`, the dashboard shows no `verify-$RUN` zones.

## Gotchas

- Run each step as its own `$C cli` line. A zsh loop over `"step command"` strings does not split words and runs the CLI without a command.
- Offline proves the requests. That bunny.net blocks cached responses and custom hostnames, and that deleting zones leaves nothing behind, shows only live.
