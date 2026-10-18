# Idempotent operations

Every job, cron, and multi-step lifecycle converges to the same end state, however many times it runs and wherever the previous run stopped.

Answer three questions for each operation that changes state:

1. What happens if it runs twice in a row?
2. What happens if the previous run crashed at each possible point?
3. Does running it again converge to the same end state?

If an answer is "it depends on what the last run left behind", add a reconciliation step.

- Derive each step from the current state, not from what the previous run meant to do. Read the state, compare it to the goal, apply the difference.
- Make anything a run leaves behind recognizable as stale by the next run. Judge staleness by stored evidence, such as a timestamp or a status, not by memory of the run.
- Write in an order that keeps every intermediate state valid: write the new object, then switch the pointer to it, then delete the old one.
- Deduplicate enqueues with a deterministic job ID derived from the entity.
- A job that can never succeed fails permanently instead of retrying.

## In this repo

- `deploy` uploads only the files whose SHA256 differs from the storage zone listing (`src/deploy.ts`), so a rerun after a crash uploads what is still missing.
- HTML uploads last, and stale files are deleted only after the upload and the edge rule sync, so every intermediate state serves a working site.
- `syncRules()` and `ensureDomains()` read the pull zone, compare it with `orbitpush.json` and the rule files, and apply the difference. Managed rules are recognized by their `orbitpush <hash>` description.
- `init` deletes both zones when anything fails before `orbitpush.json` is written, so a rerun finds the name free. Steps after that, such as domains, converge on the next `deploy`.

Adapted from pstack (MIT), see `.claude/LICENSE-pstack`.
