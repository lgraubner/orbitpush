# Agent-friendly codebase

Agents extend the patterns they see in the files they open. Shape the code so the easiest change is the right one, and treat every pattern you add as one that will be copied.

## Conventions

- Give each kind of code one home and one shape: where it lives, what it is named, and which existing file is the example to follow. The project's `CLAUDE.md` names them.
- Co-locate a feature's code in one folder. Shared code stays generic.
- Split a file once it holds several concerns. Agents keep appending to the largest file in reach.
- Keep one supported way per task. Before adding a second way, migrate the callers of the first and delete it.
- Enforce module boundaries through the import graph (lint rules, package exports, separate packages), not through prose.

## Stopping bad patterns

- A workaround, or a comment explaining one, is a pattern too: the next agent copies it. Fix the cause instead.
- When a bad pattern already exists, add a lint rule that fails only on new instances first, then clean up the existing ones.
- Fix a mistake at the highest level that works: architecture, then types and lint, then tests, then rules, then skills.
- Leave the code you touched in a state you would want copied.

## In this repo

- Each command has one file (`src/init.ts`, `src/deploy.ts`), dispatched from `src/cli.ts`.
- `ensureDomains()` lives in `src/deploy.ts`, and `src/init.ts` imports it from there. Move it out of the command file before a third caller appears.
- The API key is read two ways: `apiKeyFromEnv()` in `src/bunny.ts`, and inline in `init()` with the same error message.
- The `EnableGeoZone*` request body is built twice, in `applySettings()` and in `init()`.
