# CLI basics

The command surface every user and CI script relies on: help and version on stdout, everything else on stderr, and the exit codes `0` success, `1` error, `2` unknown command, `130` cancelled prompt.

## Sub-features

- `cli-help` with no command, `--help` or `-h` prints usage on stdout with exit `0`.
- `cli-version` with `--version` or `-v` prints the package version on stdout.
- `cli-unknown` prints usage for an unknown command, with exit `2`.
- `cli-no-key` stops with a link to the API key page when `BUNNY_API_KEY` is missing.
- `cli-no-config` tells the user to run init when `orbitpush.json` is missing.
- `cli-cancel` exits `130` when a prompt is cancelled with Ctrl-C.
- `cli-bad-flag` rejects a single-value flag given twice, with exit `1`.

## How to get to it (user POV)

- Run `orbitpush`, `orbitpush --help`, `orbitpush --version`, `orbitpush nope`, or `orbitpush deploy` before init.

## Driving it with ctl.sh

Preconditions:

- Fresh run after `launch`, before any init.

- **Help.** Run `$C cli $RUN help -- --help`. Exit `0`, stdout starts with `Deploy static sites to your own bunny.net account.`, and stderr is empty.
- **Version.** Run `$C cli $RUN version -- --version`. stdout equals the `version` in `package.json`.
- **Unknown.** Run `$C cli $RUN unknown -- nope`. Exit `2` and usage on stdout.
- **No config.** Run `$C cli $RUN no-config -- deploy`. Exit `1`, stderr `orbitpush.json not found. Run \`orbitpush init\` first.`
- **No key.** Run `$C cli $RUN no-key BUNNY_API_KEY= -- deploy`. Exit `1`, and stderr names `BUNNY_API_KEY` and `https://dash.bunny.net/account/api-key`.
- **Bad flag.** Run `$C cli $RUN bad-flag -- init --name verify-x --region DE --region NY --yes`. Exit `1`, stderr starts with `Invalid arguments: --region`, and no `bunny-state.json` is written.
- **Cancel.** Run `$C tui $RUN cancel -- init`, wait for the first prompt, then `$C keys $RUN C-c`. The screen ends with `[orbitpush exited 130]`, and no `bunny-state.json` was written (no request was sent).

## Gotchas

- `ctl.sh cli` sets `BUNNY_API_KEY=fake-key`. A `VAR=value` before `--` overrides it, so `BUNNY_API_KEY=` tests the missing key.
- With `CI` set, init never prompts. Use `tui` for prompt behavior.
