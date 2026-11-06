# CLI basics

The command surface every user and CI script relies on: help and version on stdout, everything else on stderr, and the exit codes `0` success, `1` error, `2` unknown command, `130` cancelled prompt or stopped DNS wait (`features/domains.md`).

## Sub-features

- `cli-help` with no command, `--help` or `-h` prints usage on stdout with exit `0`.
- `cli-version` with `--version` or `-v` prints the package version on stdout.
- `cli-unknown` prints usage on stderr for an unknown command, with exit `2`.
- `cli-no-key` stops with a link to the API key page when `BUNNY_API_KEY` is missing.
- `cli-no-config` tells the user to run init when `orbitpush.json` is missing, naming `orbitpush init --name <name> --dir <dir> --yes` for use without a terminal. A missing key is reported before a missing config.
- `cli-bad-config` rejects an `orbitpush.json` with an unknown key (`Unrecognized key: "x"`) before any request; `features/settings.md` covers invalid values.
- `cli-cancel` exits `130` when a prompt is cancelled with Ctrl-C.
- `cli-bad-flag` rejects a single-value flag given twice, and an option no command knows (`--domian`), with exit `1`.
- `cli-colors` writes no color codes when stderr is redirected away from the terminal, even while stdout is one.

## How to get to it (user POV)

- Run `orbitpush`, `orbitpush --help`, `orbitpush --version`, or `orbitpush nope`.
- Run `orbitpush deploy` before init without a terminal (CI, scripts). In a terminal it offers to set up a site instead (`features/deploy.md`).

## Driving it with ctl.sh

Preconditions:

- Fresh run after `launch`, before any init.

- **Help.** Run `$C cli $RUN help -- --help`. Exit `0`, stdout starts with `Deploy static sites to your own bunny.net account.` and lists `init`, `deploy`, `domains add <host>`, `domains remove <host>`, `domains list`, `disable`, `enable`, `destroy` and `migrate-netlify`, then the option groups (`--prune-hostnames`, `--primary`, the destroy `--yes`) and `BUNNY_API_KEY`, and stderr is empty. `$C cli $RUN help-h -- -h` and `$C cli $RUN help-none --` give the same stdout.
- **Version.** Run `$C cli $RUN version -- --version` and `$C cli $RUN version-v -- -v`. Both stdouts equal the `version` in `package.json`.
- **Unknown.** Run `$C cli $RUN unknown -- nope`. Exit `2`, stdout empty, and usage on stderr.
- **No config.** Run `$C cli $RUN no-config -- deploy`. Exit `1`, stderr ``orbitpush.json not found. Run `orbitpush init` first, or `orbitpush init --name <name> --dir <dir> --yes` without a terminal.``
- **No key.** Run `$C cli $RUN no-key BUNNY_API_KEY= -- deploy`. Exit `1`, and stderr names `BUNNY_API_KEY` and `https://dash.bunny.net/account/api-key`.
- **Bad flag.** Run `$C cli $RUN bad-flag -- init --name verify-x --region DE --region NY --yes`. Exit `1`, stderr `✖ Invalid arguments: --region: Invalid input: expected string, received array`. Run `$C cli $RUN bad-opt -- deploy --domian x.com`. Exit `1`, stderr ``✖ Unknown option --domian. Run `orbitpush --help` for the options.``. No `bunny-state.json` is written by either.
- **Colors.** Run `$C tui $RUN colors TUI_STDERR=file -- deploy --domian x`, which keeps stdout on the terminal and writes stderr to `colors.stderr`. When the screen shows `[orbitpush exited 1]`, `grep -cF "$(printf '\033')" .verify-artifacts/$RUN/colors.stderr` prints `0`. The same command without `TUI_STDERR=file` shows colors in `tmux capture-pane -e`.
- **Cancel.** Run `$C tui $RUN cancel -- init`, wait for the first prompt, then `$C keys $RUN C-c`. The screen ends with `[orbitpush exited 130]`, and no `bunny-state.json` was written (no request was sent).

## Gotchas

- `ctl.sh cli` sets `BUNNY_API_KEY=fake-key`. A `VAR=value` before `--` overrides it, so `BUNNY_API_KEY=` tests the missing key.
- Errors print through `log.error` with a `✖ ` prefix, so match messages as substrings.
- A prompt needs stdin and stderr on a terminal and `CI` unset, `false` or `0`; `ctl.sh cli` sets `CI=1` and reads `/dev/null`, so it never prompts. Use `tui` for prompt behavior.
