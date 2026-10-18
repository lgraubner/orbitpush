# Proof

Work is done when you observed the real result, not when it compiles, a proxy looks right, or a subagent says so.

- Read the actual value: the stored row, the sent message, the HTTP status, the page the user sees.
- Prefer a scripted check over a one-time look, and keep its output where a reviewer can rerun it.
- When a check fails unexpectedly, suspect the observation first: a stale page, the wrong instance, a cached build.
- Hand over an artifact that shows the change works as intended and is quicker to review than the diff: screenshots or a video for UI, the request and response for an API, the command and output for a CLI.
- For a user-facing change, drive the real app with the project's `verify-*` skill and report its evidence path. Name every entry point you did not drive as unverified.

## In this repo

- `npm test` proves which requests a command sends, not that bunny.net accepts them. A real `init` or `deploy` needs a `BUNNY_API_KEY` and a throwaway zone; ask first, because it changes a real account and zone names are global.
- Run the CLI from source with `node src/cli.ts <command>`, and the shipped bundle with `npm run build && node dist/cli.js <command>`.
- For a CLI change, the evidence is the command, its stderr, and its exit code.

Adapted from pstack (MIT), see `.claude/LICENSE-pstack`.
