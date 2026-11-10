<!--
The Types, Changes and debugging, Idempotent operations, and Tests sections are adapted from pstack (MIT), see .claude/LICENSE-pstack.
-->

# orbitpush

A Node CLI in TypeScript, bundled with esbuild into one file, that deploys a static site to the user's own bunny.net storage zone and pull zone. Read `GLOSSARY.md` for the domain language, `README.md` for the behavior users rely on, and `docs/` for decisions and Netlify parity.

## Working

- When a step doesn't need my input, keep going. Put status notes in the same message as your next action.
- A bug report, a question, or a design discussion is an investigation: it ends with the cause and the change you propose. Edit files once I ask for the change or run `/full-stop`.
- Stop and ask only when you can't continue without me, or before anything destructive: deleting data, force-pushing, publishing, or changing anything outside this repository. Running `init`, `deploy`, or `npm run test:e2e` against a real bunny.net account counts as outside. Ask with `AskUserQuestion`, so the session shows it is waiting.
- Before asking which approach to take, check whether running something can answer it: behavior, timing, output, or performance. If it can, try it and let the result decide. Ask only for product or preference calls no experiment settles.
- Before writing code, take the first that works: no code (the need is speculative), code already in this repo, the standard library, a platform feature, an installed dependency, then the minimum new code.
- Give your real judgment. Push back or say that something does not earn its place when that is true; agreement is not the default.
- Back each claim with its evidence, or label it as measured, inferred, or a guess. Run any check you could run yourself instead of handing it to me.

## Conventions

One home per kind of code, and the file to copy when adding one:

```
src/
  cli.ts                  the entry: help, flag parsing, dispatch, exit codes
  commands/<command>.ts   one file per command, exporting the command function; follow deploy.ts
  bunny.ts                all bunny.net HTTP, its response schemas, and steps several commands share
  config.ts               orbitpush.json: schema, read, write
  rules.ts                redirects and headers from orbitpush.json to edge rules
  args.ts                 CLI flags
  files.ts log.ts zod.ts  missing files, terminal output, schemas
test/<module>.test.ts     unit tests per src file, no network
e2e/                      Playwright against real bunny.net; demo sites in e2e/sites/
```

Import everything under `src/` with `@/` (`paths` in `tsconfig.json`, which esbuild and vitest read too), files in the same folder too; relative imports only outside `src/`. Only `cli.ts` imports from `src/commands/`; code that several commands share lives beside `cli.ts`. `eslint/no-restricted-imports` enforces both.

- bunny.net HTTP: only through `api()`, `apiJson()` and `storage()` in `src/bunny.ts`. A response that is read goes through `apiJson()` with a schema from the same file.
- Steps that several commands run, such as `ensureDomains()`, pull zone reads and cache purges (`getPullZone()`, `purgeCache()`), and whether a hostname is on the pull zone and connected (`findHostname()`, `isConnected()`), live in `src/bunny.ts`.
- The API key has one source: `envApiKey()` in `src/bunny.ts`. `apiKeyFromEnv()` throws the missing-key error, and `init` falls back to a prompt. The `EnableGeoZone*` request body has one builder: `geoZoneFlags()`.
- Schemas: `z` from `src/zod.ts`, which loads the English error messages. Never import `zod/mini` directly.
- Reading a file that may be missing: `isMissing()` and `readIfExists()` in `src/files.ts`. Only ENOENT counts as missing.
- Terminal output: `log` from `src/log.ts`, which writes to stderr. Only `--help` and `--version` write to stdout. An error turns into text through `errorMessage()` in `src/log.ts`, not through `as Error` casts.
- Runtime packages are dev dependencies: esbuild bundles them, and the published package has none.

Agents extend the patterns they see, so treat every pattern you add as one that will be copied:

- Split a file once it holds several concerns. Agents keep appending to the largest file in reach.
- Enforce module boundaries through the import graph (lint rules, package exports, separate packages), not through prose.
- A workaround, or a comment explaining one, is a pattern too: the next agent copies it. Fix the cause instead.
- When a bad pattern already exists, add a lint rule that fails only on new instances first, then clean up the existing ones.

## Boundaries

Untrusted data is parsed once, where it enters, into a named domain type:

| Boundary                                 | Parser                                                                                                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `BUNNY_API_KEY`                          | `envApiKey()` and `apiKeyFromEnv()` in `src/bunny.ts`                                                                                          |
| `CI`                                     | `interactive` in `src/cli.ts`                                                                                                                  |
| CLI flags                                | `parseArgs()` in `src/args.ts`, then the checks in `init()`                                                                                    |
| Interactive prompts                      | the `validate` options in `src/commands/init.ts`                                                                                               |
| `orbitpush.json`                         | `ConfigSchema` in `readConfig()` in `src/config.ts`, then `redirectRules()` and `headerRules()` in `src/rules.ts` for what bunny.net can serve |
| `netlify.toml`, `_redirects`, `_headers` | `parseNetlifyToml()`, `parseRedirectsFile()` and `parseHeadersFile()` in `src/commands/migrate-netlify.ts`, only for `migrate-netlify`         |
| bunny.net API responses                  | the zod schemas in `src/bunny.ts`, through `apiJson()`, `storage().list()` and `storage().read()`, which reads the stale record                |

- Hand the parsed value on, not the raw input. Code behind the boundary takes the domain type and does not validate again. `parseArgs()` parses the `mri` output, which is typed as `any`, so no flag reaches `init` unchecked.
- Expose domain types across a boundary, not the transport, storage, or wire types behind it.
- Resolve an `as` cast by finding the boundary it skips and parsing there. A cast is right only for a fact the type system cannot express, after validation.
- A bunny.net response that does not match its schema throws `bunny.net returned an unexpected response for ...` before any write follows.
- An unknown key in `orbitpush.json` fails the parse; `$schema` is accepted and dropped.

Public contracts with callers outside the repo stay compatible; version a breaking change instead of deleting the old path: the commands, flags, and exit codes (`1` error, `2` unknown command, `130` cancelled prompt); `BUNNY_API_KEY`; the `orbitpush.json` format, including the Netlify shape of `redirects` and `headers`, and `schema.json`, served from unpkg; and the `orbitpush <hash>` description prefix that marks the edge rules already deployed on users' pull zones.

## Types

Make the compiler reject impossible states.

- Model variants as a discriminated union, not as a bag of optional fields. If a comment explains when a combination of fields is valid, split it into a union.
- Give each lifecycle one status field with a literal union instead of a second boolean that must stay in sync with the first.
- Prefer a lookup table or a `satisfies Record<Union, …>` map over an if/else chain that grows by one branch per feature.
- Keep the plain type while every operation on it stays total. Strengthen it only where the loose type forces a `!`, an `as`, or a "should never happen" branch.
- Brand an ID when two IDs of the same primitive type travel through the same call and can be swapped.
- Keep code boring when the shape is clear, local, and unlikely to grow. An abstraction earns its place by deleting branches, duplicated rules, or invalid states.
- Derive a closed set from its one list: `Region` comes from `STORAGE_REGIONS` in `src/config.ts`, and both `readConfig()` and `init()` parse through it. `EdgeRule` in `src/rules.ts` pins the wire constants bunny.net expects as literal types, such as `TriggerMatchingType: 0`.

## Changes and debugging

Fix the fault where it starts, and leave the design simpler than you found it.

- The root cause is the first place the system did something it should not, or failed to handle a state it should; the symptom is only where that became visible. Ask whether the state that broke the code is legitimate. If it is, handle it where it broke. If it is not, find what produced it. Guards, retries, swallowed errors, clamped values, and fallback defaults are the usual ways to hide a bug. Swallowing every read error once let an unreadable `_redirects` delete every managed redirect; now only ENOENT counts as missing.
- Instrument when stuck: read the actual error, the log, the stored state. A failed bunny.net call throws `<METHOD> <path> failed: <Message> (HTTP <status>)` from `errorText()` in `src/bunny.ts`; read that message before guessing. To see which requests a command sends, reuse `fakeBunny()` from its test file.
- When two fixes fail the same check, they likely share a wrong assumption. Write that assumption down in one sentence and test it before a third fix.
- After a fix, search for the same fault elsewhere and fix every instance.
- When the deciding fact took a deep dig to find, propose the cheap always-on signal (a log field, a metric, a status) that would have shown it at first look.
- Integrate a new requirement as if it had been there from the start. Propagate it through types, docs, and tests, then deliver it in small steps.
- Remove dead code, stale validators, and unused options before building on top of them.
- Design for observed usage.
- Keep one supported way per task. Replace an internal API in one change: inventory its callers, migrate them, and delete the old API. A temporary adapter needs a named removal step. Public contracts under Boundaries are the exception: `rule()` in `src/rules.ts` hashes the rule body into the description, so changing that body's shape makes every user's next deploy delete and re-add all managed rules.
- For a mechanical change across many files, write a codemod or script instead of editing each file by hand: change one file by hand, make the script reproduce that change exactly, then run it on the rest. When the work is split across subagents, hand each the same tool.
- When the same correction comes up twice, make the mistake impossible at the highest level that works: architecture, then a type or lint rule, then a test or hook, instead of another instruction. Suggest `/correct` to the user; only they can run it.

## Idempotent operations

Every command that changes a storage zone, pull zone, or edge rule converges to the same end state, however many times it runs and wherever the previous run stopped. For each one, ask what happens if it runs twice, and if the previous run crashed at each possible point. If the answer depends on what the last run left behind, add a reconciliation step.

- Derive each step from the current state, not from what the previous run meant to do. Read the state, compare it to the goal, apply the difference. `syncRules()` and `ensureDomains()` read the pull zone, compare it with `orbitpush.json`, and apply the difference; `deploy` uploads only the files whose SHA256 differs from the storage zone listing.
- Make anything a run leaves behind recognizable as stale by the next run, through stored evidence such as a timestamp or a status. Managed rules are recognized by their `orbitpush <hash>` description.
- Write in an order that keeps every intermediate state valid: write the new object, then switch the pointer to it, then delete the old one. `deploy` uploads HTML last and deletes stale files only after the upload and the edge rule sync, so every intermediate state serves a working site.
- `init` deletes both zones when anything fails before `orbitpush.json` is written, so a rerun finds the name free. Steps after that, such as domains, converge on the next `deploy`.

## Documentation

- `GLOSSARY.md` is the glossary. Use its terms in code, CLI output, and conversation. When a discussion settles a new or sharper term, update it in the same change.
- Record a decision in `docs/adr/` only when it is hard to reverse, would surprise a reader without context, and came from a real trade-off.
- `README.md` describes current behavior. Update it, and `schema.json` for config changes, in the same change when that behavior changes.
- `CHANGELOG.md` lists user-visible changes. Add each one under `Unreleased` in the same change; a release moves them under its version.
- Keep credentials, secret values, production identifiers, and private URLs out of documentation.

## Tests

Unit tests live in `test/*.test.ts` and run with `npm test` (vitest). They never reach the network or read `BUNNY_API_KEY`: each file's `fakeBunny()` replaces `fetch` with `vi.spyOn` and records the requests. `npm run test:e2e` (Playwright, `e2e/`) deploys the demo sites in `e2e/sites/` to the real bunny.net account of `BUNNY_API_KEY`; ask before running it.

A test is a claim about what the code does for its users: a caller, an end user, or another service. Assert what they can observe: return values, errors callers branch on, state they can read back, and effects outside the code, such as a row written, a message sent, or the payload another participant receives. Internal helpers, call order, and intermediate data are implementation. Judge each test against two imagined edits: break the behavior (it must fail) and restructure the internals while keeping every result (it must pass). Rewrite or delete tests that fail either.

- A command test asserts the requests sent to bunny.net (method, URL, body), because the terminal output can hide a wrong or missing write. `test/deploy.test.ts` also asserts their order on purpose: HTML last and deletes after uploads are behavior.
- `test/rules.test.ts` asserts the Lua patterns and actions the parsers produce, which is what bunny.net receives, and pins two managed rule hashes, because deployed rules are matched by them.
- A new test counts once you have seen it go **red**: break the behavior it covers, watch it fail, restore.
- Prefer end-to-end tests through the real app. Test units in isolation only where end-to-end reaches poorly: limits, validation edge cases, timing. There, work test-first: list every way the unit could fail, write a test per failure mode, then the code.
- Derive the expected value from the requirement, never from the code under test.
- Pair a "not called" assertion with a "called" case, so the test shows it can see the call.
- Assert the error type or code callers branch on, not the wording of a message nobody reads.
- Hand tests for code you just wrote to the `test-writer` agent, with a brief (the intent and what is out of scope) and the entry points instead of the diff. A test written first, before the code, stays with you.

## Comments

Write a comment only for one of these; `/no-comments` removes the rest:

- A legal or license header.
- An outside rule the code works around: a dependency, platform, vendor, spec, or protocol we cannot reshape. The comment names the rule, even when the workaround is our own code.
- A doc comment on one of the public contracts under Boundaries. Exports of internal packages or modules are not public.
- An issue or RFC link that explains a constraint code cannot express.
- A lint suppression whose rule is faulty, pedantic, or style-only.
- A lint or type exception from `/correct`: it names its reason, an expiry date, and the approving human.

Write them in short, full sentences. Record a deliberate shortcut's limit in the PR description, or enforce it with a type, lint, or test.

## Commits

Write every commit message as a Conventional Commit: `type(scope)!: subject`, with a lowercase subject. Pull request titles follow the same format. The `commit-msg` hook and CI on pull requests enforce it with commitlint; when commitlint rejects a message, rewrite the message and commit again.

## Done

A change is done when `npm run check` is **green** and you observed the real result, not when it compiles, a proxy looks right, or a subagent says so. Run `npm run format` first, since the gate only checks formatting. Judge the gate by its own exit code (`npm run check; echo $?`): a pipe through `tail` or `grep` reports the last command's status instead. CI runs the scripts that the gate chains as separate steps in `.github/workflows/ci.yml`; a script added to the gate gets a step there too. When dependencies or the `build` script change, also run the bundle: `node dist/cli.js --help`.

- Read the actual value: the requests sent to bunny.net, the command's stderr and exit code, the page the site serves.
- `npm test` proves which requests a command sends, not that bunny.net accepts them. A real `init` or `deploy` needs a `BUNNY_API_KEY` and a throwaway zone; ask first, because it changes a real account and zone names are global.
- Prefer a scripted check over a one-time look, and keep its output where a reviewer can rerun it.
- When a check fails unexpectedly, suspect the observation first: a stale page, the wrong instance, a cached build.
- Hand over an artifact that shows the change works and is quicker to review than the diff: for a CLI change, the command, its stderr, and its exit code. Run the CLI from source with `node --import ./test/alias.ts src/cli.ts <command>` (the hook resolves `@/`), and the shipped bundle with `npm run build && node dist/cli.js <command>`.
- For a user-facing change, drive the real app with the `verify-orbitpush` skill and report its evidence path. Name every entry point you did not drive as unverified.
