#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SKILL_DIR/../../.." && pwd)"
FAKE="$SKILL_DIR/fake-bunny.mjs"
CLI="$REPO/dist/cli.js"

usage() {
  cat >&2 <<'EOF'
Usage:
  ctl.sh launch  <run-id>                      Build dist/cli.js, create the work dir and evidence dir
  ctl.sh doctor  <run-id>                      Check build, version, isolation and the fake
  ctl.sh cli     <run-id> <step> [env=val...] -- <args...>
                                               Run `orbitpush <args>` non-interactively, record evidence
  ctl.sh tui     <run-id> <step> [env=val...] -- <args...>   (TUI_STDERR=file: stderr to <step>.stderr)
                                               Start `orbitpush <args>` in a tmux session (real TTY)
  ctl.sh keys    <run-id> <tmux send-keys args...>
  ctl.sh screen  <run-id> <name>               Save the tmux pane to <evidence>/<name>.screen.txt
  ctl.sh summary <run-id> <name>               Save the fake bunny.net state to <evidence>/<name>.summary.json
  ctl.sh cleanup <run-id>                      Kill this run's tmux session, delete its work dir

Live mode (real bunny.net account; only with the user's approval for this run):
  ctl.sh live         <run-id> <step> -- <args...>  Run `orbitpush <args>` with the real BUNNY_API_KEY
  ctl.sh live-destroy <run-id>                      Delete the zones in this run's orbitpush.json
                                                    (refuses names that do not start with verify-)
EOF
  exit 2
}

[[ $# -ge 2 ]] || usage
cmd="$1"
run="$2"
shift 2
[[ "$run" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "run-id: letters, digits, - and _ only" >&2; exit 2; }

WORK="${TMPDIR:-/tmp}"
WORK="${WORK%/}/orbitpush-verify/$run"
SITE="$WORK/site"
EVIDENCE="$REPO/.verify-artifacts/$run"
STATE="$EVIDENCE/bunny-state.json"
SESSION="orbitpush-verify-$run"

split_args() {
  ENV_ARGS=()
  CLI_ARGS=()
  while [[ $# -gt 0 && "$1" != "--" ]]; do ENV_ARGS+=("$1"); shift; done
  [[ $# -gt 0 ]] && shift
  CLI_ARGS=("$@")
}

case "$cmd" in
  launch)
    (cd "$REPO" && npm run build >/dev/null 2>&1) || { echo "build failed: run npm run build in $REPO" >&2; exit 1; }
    rm -rf "$WORK"
    mkdir -p "$SITE" "$EVIDENCE"
    cp -R "$SKILL_DIR/fixtures/site/." "$SITE/"
    echo "work dir: $SITE"
    echo "evidence: $EVIDENCE"
    echo "ready: $(node "$CLI" --version)"
    ;;

  doctor)
    ok=1
    check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; ok=0; fi; }
    check "dist/cli.js exists" "[[ -f '$CLI' ]]"
    check "dist/cli.js is newer than every src/*.ts" \
      "[[ -z \$(find '$REPO/src' -name '*.ts' -newer '$CLI') ]]"
    check "--version matches package.json" \
      "[[ \$(node '$CLI' --version) == \$(node -p \"require('$REPO/package.json').version\") ]]"
    check "work dir has the fixture site" "[[ -f '$SITE/public/index.html' ]]"
    check "evidence dir exists" "[[ -d '$EVIDENCE' ]]"
    check "fake blocks non-bunny network" \
      "FAKE_BUNNY_STATE='$WORK/doctor-state.json' node --import '$FAKE' -e \
        'fetch(\"https://example.com\").then(() => process.exit(1), (e) => process.exit(/blocked/.test(e.message) ? 0 : 1))'"
    if tmux has-session -t "=$SESSION" 2>/dev/null; then echo "info tmux session $SESSION is running"; fi
    rm -f "$WORK/doctor-state.json"
    [[ $ok == 1 ]] || exit 1
    ;;

  cli)
    [[ $# -ge 1 ]] || usage
    step="$1"
    shift
    split_args "$@"
    mkdir -p "$EVIDENCE"
    printf 'orbitpush %s\n' "${CLI_ARGS[*]-}" >"$EVIDENCE/$step.cmd"
    set +e
    (cd "$SITE" && env -u CI CI=1 BUNNY_API_KEY=fake-key FAKE_BUNNY_STATE="$STATE" ${ENV_ARGS[@]+"${ENV_ARGS[@]}"} \
      node --import "$FAKE" "$CLI" ${CLI_ARGS[@]+"${CLI_ARGS[@]}"} \
      >"$EVIDENCE/$step.stdout" 2>"$EVIDENCE/$step.stderr" </dev/null)
    code=$?
    set -e
    echo "$code" >"$EVIDENCE/$step.exit"
    echo "--- $step: orbitpush ${CLI_ARGS[*]-} (exit $code)"
    echo "--- stdout"; cat "$EVIDENCE/$step.stdout"
    echo "--- stderr"; cat "$EVIDENCE/$step.stderr"
    ;;

  tui)
    [[ $# -ge 1 ]] || usage
    step="$1"
    shift
    split_args "$@"
    mkdir -p "$EVIDENCE"
    printf 'orbitpush %s\n' "${CLI_ARGS[*]-}" >"$EVIDENCE/$step.cmd"
    tmux kill-session -t "=$SESSION" 2>/dev/null || true
    quoted=""
    envs=""
    redirect=""
    for arg in ${CLI_ARGS[@]+"${CLI_ARGS[@]}"}; do quoted+="$(printf '%q' "$arg") "; done
    for arg in ${ENV_ARGS[@]+"${ENV_ARGS[@]}"}; do
      # TUI_STDERR=file keeps stdout on the terminal and sends stderr to <step>.stderr
      if [[ "$arg" == "TUI_STDERR=file" ]]; then
        redirect="2>$(printf '%q' "$EVIDENCE/$step.stderr")"
      else
        envs+="$(printf '%q' "$arg") "
      fi
    done
    tmux new-session -d -s "$SESSION" -x 120 -y 40 -c "$SITE" \
      "env -u CI BUNNY_API_KEY=fake-key FAKE_BUNNY_STATE=$(printf '%q' "$STATE") $envs node --import $(printf '%q' "$FAKE") $(printf '%q' "$CLI") $quoted $redirect; echo \"[orbitpush exited \$?]\"; sleep 3600"
    echo "tmux session: $SESSION"
    ;;

  keys)
    tmux send-keys -t "=$SESSION:" "$@"
    ;;

  screen)
    [[ $# -eq 1 ]] || usage
    mkdir -p "$EVIDENCE"
    tmux capture-pane -p -t "=$SESSION:" | tee "$EVIDENCE/$1.screen.txt"
    ;;

  summary)
    [[ $# -eq 1 ]] || usage
    node "$FAKE" summary "$STATE" | tee "$EVIDENCE/$1.summary.json"
    ;;

  cleanup)
    tmux kill-session -t "=$SESSION" 2>/dev/null || true
    rm -rf "$WORK"
    echo "removed $WORK; evidence kept in $EVIDENCE"
    ;;

  live)
    [[ $# -ge 1 ]] || usage
    [[ -n "${BUNNY_API_KEY:-}" ]] || { echo "live: BUNNY_API_KEY is not set" >&2; exit 2; }
    step="$1"
    shift
    split_args "$@"
    mkdir -p "$EVIDENCE"
    printf 'LIVE orbitpush %s\n' "${CLI_ARGS[*]-}" >"$EVIDENCE/$step.cmd"
    set +e
    (cd "$SITE" && env -u CI CI=1 node "$CLI" ${CLI_ARGS[@]+"${CLI_ARGS[@]}"} \
      >"$EVIDENCE/$step.stdout" 2>"$EVIDENCE/$step.stderr" </dev/null)
    code=$?
    set -e
    echo "$code" >"$EVIDENCE/$step.exit"
    echo "--- LIVE $step: orbitpush ${CLI_ARGS[*]-} (exit $code)"
    echo "--- stdout"; cat "$EVIDENCE/$step.stdout"
    echo "--- stderr"; cat "$EVIDENCE/$step.stderr"
    ;;

  live-destroy)
    [[ -n "${BUNNY_API_KEY:-}" ]] || { echo "live-destroy: BUNNY_API_KEY is not set" >&2; exit 2; }
    config="$SITE/orbitpush.json"
    [[ -f "$config" ]] || { echo "live-destroy: no $config, nothing created by this run" >&2; exit 1; }
    name="$(node -p "require('$config').name")"
    [[ "$name" == verify-* ]] || { echo "live-destroy: refusing to delete zones named $name" >&2; exit 1; }
    for zone in "pullzone:$(node -p "require('$config').pullZoneId")" "storagezone:$(node -p "require('$config').storageZoneId")"; do
      kind="${zone%%:*}"
      id="${zone#*:}"
      found="$(curl -sS -H "AccessKey: $BUNNY_API_KEY" "https://api.bunny.net/$kind/$id" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).Name??"")}catch{}})')"
      if [[ "$found" != "$name" ]]; then echo "skip $kind $id: name is '${found}', expected $name"; continue; fi
      status="$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE -H "AccessKey: $BUNNY_API_KEY" "https://api.bunny.net/$kind/$id")"
      echo "DELETE $kind $id ($name): HTTP $status" | tee -a "$EVIDENCE/live-destroy.log"
    done
    ;;

  *) usage ;;
esac
