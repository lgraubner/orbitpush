---
name: verify-orbitpush
description: Drive the real orbitpush CLI (the built dist/cli.js) through init and deploy and capture proof. Offline against a recording fake of bunny.net by default; live against a real bunny.net account only with the user's approval. Use to prove a change to init, deploy, edge rules, settings, or CLI flags works for a user, beyond unit tests.
---

# Verify orbitpush

orbitpush is a CLI. The user-facing surface is `orbitpush init` (interactive prompts or flags) and `orbitpush deploy`, run in a project directory, talking to bunny.net. There is no server: every drive is one CLI process in its own work directory.

Two modes:

- **Offline (default).** The bundled `dist/cli.js` runs under `node --import fake-bunny.mjs`. The fake replaces `fetch`: it serves `api.bunny.net` and `*.storage.bunnycdn.com` from a JSON state file, records every request, and throws on any other host. Proves everything orbitpush decides and sends. It cannot prove how bunny.net acts on it: whether the Lua trigger patterns match, whether redirects and headers reach a browser, SSL issuance.
- **Live.** The same CLI against the user's real bunny.net account. It creates and deletes real zones, so it needs the user's explicit approval for each run (CLAUDE.md, Working). Never start it on your own. Use it when the claim is about bunny.net behavior.

All commands below run from the repository root. `C=.claude/skills/verify-orbitpush/ctl.sh` and a run ID of letters, digits, `-` and `_`, unique per run (`RUN=$(date +%H%M%S)`).

## Launch

```bash
$C launch $RUN
```

Builds `dist/cli.js` (`npm run build`), creates the work dir `$TMPDIR/orbitpush-verify/$RUN/site` from `fixtures/site/`, and the evidence dir `.verify-artifacts/$RUN/` (gitignored). Ready when it prints `ready: <version>`. The fixture is a built site in `public/` with `index.html`, `404.html`, `about.html`, `assets/app.js`, and, beside `public/`, a `rules.json` with `redirects` (three supported, two unsupported) and `headers` (two entries). It has no `orbitpush.json`: every journey starts with `init`. A journey that needs the rules merges them into `orbitpush.json` after `init`: `jq -s '.[0] + .[1]' orbitpush.json rules.json > o.json && mv o.json orbitpush.json` in the work dir.

Runs are isolated by run ID: separate work dir, state file, evidence dir, and tmux session `orbitpush-verify-$RUN`. Parallel runs are safe. Never reuse another run's ID.

## Doctor

```bash
$C doctor $RUN
```

Read-only. Checks that `dist/cli.js` exists and is newer than every `src/*.ts`, `--version` matches `package.json`, the work dir holds the fixture, the evidence dir exists, and the fake blocks a non-bunny URL. Any `FAIL` exits 1: rerun `launch` (a stale build is the usual cause). Run it first, and again whenever output looks wrong.

## Drive

Non-interactive (flags, `deploy`, error paths). Sets `CI=1`, `BUNNY_API_KEY=fake-key`, stdin from `/dev/null`:

```bash
$C cli $RUN <step> [VAR=value ...] -- <orbitpush args>
# e.g.
$C cli $RUN init -- init --name verify-a --dir public --yes
$C cli $RUN deploy-1 -- deploy
$C cli $RUN deploy-fail FAKE_BUNNY_FAIL="POST /pullzone/1001/purgeCache" -- deploy
```

Interactive prompts need a real TTY, so they run in tmux:

```bash
$C tui $RUN <step> -- init
$C screen $RUN <name>                 # pane -> evidence/<name>.screen.txt
$C keys $RUN C-u verify-a Enter       # tmux send-keys arguments
```

The pane ends with `[orbitpush exited <code>]` when the CLI exits. Wait about 0.5 s after each key before taking a screen. The prompts are identified by their text; `features/init.md` lists them.

Fake knobs, as `VAR=value` before `--`: `FAKE_BUNNY_CERT=ok` lets SSL certificates succeed (default fails, like DNS that is not pointed yet). `FAKE_BUNNY_FAIL="<METHOD> <path>"` answers that request with HTTP 500 and changes no state, like a failed bunny.net call. The fake gives IDs from 1000: the first storage zone is 1000, the first pull zone 1001. Taken names answer HTTP 400.

Read what bunny.net received:

```bash
$C summary $RUN <name>                # zones, stored files, edge rules, purges, writes
```

## Evidence

Everything lands in `.verify-artifacts/$RUN/`:

- `<step>.cmd`, `<step>.stdout`, `<step>.stderr`, `<step>.exit` for each `cli`/`live` step.
- `<name>.screen.txt` for each tmux screen.
- `bunny-state.json`, the fake's full state and request log (`requests[]` with method, URL, status, JSON body), and `<name>.summary.json` snapshots of it.

Proof standards:

- Drive the CLI the way a user does: `dist/cli.js` with flags, prompts, files in the output directory. Never call `src/` functions or edit the state file to set up a case. A journey that needs a precondition creates it through the CLI or by editing the user's files (`public/`, `orbitpush.json`).
- Capture the action and the result: the command and its exit code and stderr, plus a summary taken after it. Terminal output alone can hide a missing or wrong write: assert the write in the summary or the request log.
- Verify side effects: files stored, edge rules present or gone, purge count, zone settings, `orbitpush.json` written.
- The fake is a stand-in only at the bunny.net boundary. A claim about bunny.net's behavior (patterns matching, headers served, certificates) needs live mode; report it as unverified otherwise.

## Live mode

Only after the user approved this run. Name everything `verify-<something>`: `live-destroy` refuses other names.

```bash
$C launch $RUN
$C live $RUN init -- init --name verify-$RUN --dir public --yes
$C live $RUN deploy-1 -- deploy
HOST=verify-$RUN.b-cdn.net   # new pull zones can take a minute to answer
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://$HOST/old \
  | tee .verify-artifacts/$RUN/live-old.txt
curl -sSI https://$HOST/ | tee .verify-artifacts/$RUN/live-root-headers.txt
$C live-destroy $RUN
```

For a claim that spans sites or the whole lifecycle, run `npm run test:e2e` instead (same approval rule): it deploys the demo sites in `e2e/sites/` and checks pages, redirects, headers, domains, disable, enable and destroy in Chromium.

`live` uses the real `BUNNY_API_KEY` from the environment and records the same evidence as `cli`. `features/edge-rules.md` and `features/settings.md` list the live checks. `live-destroy` deletes the pull zone and storage zone from this run's `orbitpush.json` after checking their names, and logs to `live-destroy.log`. Run it even when a step failed; if `init` failed before writing `orbitpush.json`, check the dashboard for `verify-$RUN` zones and tell the user.

## Cleanup

```bash
$C cleanup $RUN
```

Kills only the tmux session `orbitpush-verify-$RUN` and deletes only `$TMPDIR/orbitpush-verify/$RUN`. Evidence in `.verify-artifacts/$RUN/` stays. Never kill tmux sessions or processes by name pattern: the user runs unrelated sessions, including one named `orbitpush`. In live mode, run `live-destroy` before `cleanup`, because it reads `orbitpush.json` from the work dir.

## Helpers

- `ctl.sh` (executable): every subcommand above. `ctl.sh` without arguments prints usage.
- `fake-bunny.mjs`: the preload. `node fake-bunny.mjs summary <state.json>` prints a summary. The knobs are listed under Drive.
- `fixtures/site/`: the fixture project, copied into each work dir.

## Feature map

`features/README.md` indexes the user-facing features and their recipes. Prove a change through every entry point the map lists for it, and update the map in the same change when a feature or entry point changes.
