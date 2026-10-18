# orbitpush

A Node CLI in TypeScript, bundled with esbuild into one file, that deploys a static site to the user's own bunny.net storage zone and pull zone. Read `GLOSSARY.md` for the domain language and `README.md` for the behavior users rely on.

## Working

- When a step doesn't need my input, keep going. Put status notes in the same message as your next action.
- Stop and ask only when you can't continue without me, or before anything destructive: deleting data, force-pushing, publishing, or changing anything outside this repository. Running `init` or `deploy` against a real bunny.net account counts as outside.
- Before asking which approach to take, check whether running something can answer it: behavior, timing, output, or performance. If it can, try it and let the result decide. Ask only for product or preference calls no experiment settles.
- Give your real judgment. Push back or say that something does not earn its place when that is true; agreement is not the default.
- Back each claim with its evidence, or label it as measured, inferred, or a guess. Run any check you could run yourself instead of handing it to me.

## Conventions

One home per kind of code, and the file to copy when adding one:

- Commands: one `src/<command>.ts` exporting the command function, dispatched from `src/cli.ts`; follow `src/deploy.ts`.
- bunny.net HTTP: only through `api()`, `apiJson()` and `storage()` in `src/bunny.ts`. A response that is read goes through `apiJson()` with a schema from the same file.
- Reading a file that may be missing: `isMissing()` and `readIfExists()` in `src/files.ts`. Only ENOENT counts as missing.
- `_redirects` and `_headers` to edge rules: `src/rules.ts`.
- Terminal output: `log` from `src/log.ts`, which writes to stderr. Only `--help` and `--version` write to stdout.
- Runtime packages are dev dependencies: esbuild bundles them, and the published package has none.

## Boundaries

Untrusted data is parsed where it enters:

| Boundary                 | Parser                                                    |
| ------------------------ | --------------------------------------------------------- |
| `BUNNY_API_KEY`          | `envApiKey()` and `apiKeyFromEnv()` in `src/bunny.ts`     |
| CLI flags                | `mri` in `src/cli.ts`, then the checks in `init()`        |
| Interactive prompts      | the `validate` options in `src/init.ts`                   |
| `orbitpush.json`         | `ConfigSchema` in `readConfig()` in `src/config.ts`       |
| `_redirects`, `_headers` | `parseRedirects()` and `parseHeaders()` in `src/rules.ts` |
| bunny.net API responses  | the zod schemas in `src/bunny.ts`, through `apiJson()`    |

Public contracts with callers outside the repo stay compatible: the commands, flags, and exit codes (`1` error, `2` unknown command, `130` cancelled prompt); `BUNNY_API_KEY`; the `orbitpush.json` format and `schema.json`, served from unpkg; the supported `_redirects` and `_headers` syntax; and the `orbitpush <hash>` description prefix that marks the edge rules already deployed on users' pull zones.

## Principles

Read the matching file in `.claude/principles/` before the work:

- Types, `orbitpush.json` or flag validation, or bunny.net responses: `types-and-boundaries.md`.
- Debugging, refactoring, or replacing an API: `changes-and-debugging.md`.
- `init`, `deploy`, or any step that changes a storage zone, pull zone, or edge rule: `idempotent-operations.md`.
- Writing or changing a test: `tests.md`.
- Adding a pattern, a workaround, a module, or a boundary: `agent-friendly-codebase.md`.
- Declaring work done: `proof.md`.

## Documentation

- `GLOSSARY.md` is the glossary. Use its terms in code, CLI output, and conversation. When a discussion settles a new or sharper term, update it in the same change.
- Record a decision in `docs/adr/` only when it is hard to reverse, would surprise a reader without context, and came from a real trade-off.
- `README.md` describes current behavior. Update it, and `schema.json` for config changes, in the same change when that behavior changes.
- Keep credentials, secret values, production identifiers, and private URLs out of documentation.

## Tests

Tests live in `test/*.test.ts` and run with `npm test` (vitest). They never reach the network: each file's `fakeBunny()` replaces `fetch` with `vi.spyOn` and records the requests.

- A command test asserts the requests sent to bunny.net (method, URL, body), because the terminal output can hide a wrong or missing write.
- Hand tests for code you just wrote to the `test-writer` agent, with the spec and the entry points instead of the diff. A test written first, before the code, stays with you.

## Comments

Write a comment only for one of these; `/no-comments` removes the rest:

- A legal or license header.
- An outside rule the code works around: a dependency, platform, vendor, spec, or protocol we cannot reshape. The comment names the rule, even when the workaround is our own code.
- A doc comment on one of the public contracts under Boundaries. Exports of internal packages or modules are not public.
- An issue or RFC link that explains a constraint code cannot express.
- A lint suppression whose rule is faulty, pedantic, or style-only.
- A lint or type exception from `/correct`: it names its reason, an expiry date, and the approving human.

Write them in short, full sentences. `.claude/rules/typescript.md` sets their punctuation in TypeScript. Record a deliberate shortcut's limit in the PR description, or enforce it with a type, lint, or test. This overrides the ponytail plugin's `ponytail:` comment markers.

## Commits

Write every commit message as a Conventional Commit: `type(scope)!: subject`, with a lowercase subject. Pull request titles follow the same format. When commitlint rejects a message, rewrite the message and commit again.

## Done

A change is done when `npm run check` is **green**; run `npm run format` first, since the gate only checks formatting. Judge by its own exit code (`npm run check; echo $?`): a pipe through `tail` or `grep` reports the last command's status instead. When dependencies or the `build` script change, also run the bundle: `node dist/cli.js --help`.

To see a change working in the real app, use the `verify-orbitpush` skill (create it with `/create-verification-skill`).
