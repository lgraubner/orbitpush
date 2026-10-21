# orbitpush verification map

The maintained source for verifying what orbitpush users rely on. Read this index, then use the matching feature file as the recipe. `../SKILL.md` explains launch, doctor, the `ctl.sh` commands, and cleanup.

## Baseline preconditions

- `ctl.sh launch $RUN` ran for a fresh run ID and `ctl.sh doctor $RUN` passed.
- The work dir holds the fixture site with no `orbitpush.json`. Recipes that need a project run `init` first, as stated in their preconditions.
- Offline mode unless the user approved a live run.

## Driving conventions

- `C=.claude/skills/verify-orbitpush/ctl.sh`, run from the repository root.
- Prompts are identified by their question text. Answer them through `$C keys`, then confirm the answer on a `$C screen`.
- Edit only user files to set up a case: `public/**`, `orbitpush.json` and `netlify.toml` in `$TMPDIR/orbitpush-verify/$RUN/site`. Never edit `bunny-state.json`.
- Name projects `verify-<something>`. Live cleanup refuses other names.

## Proof and skip reporting

- Command proof is `<step>.cmd`, `.stdout`, `.stderr` and `.exit`.
- Write proof is a `$C summary` after the step, or the matching entries in `bunny-state.json` `requests[]`.
- A claim about how bunny.net behaves (pattern matching, served headers, redirects, SSL) is proven only by a live run. Report it as unverified after an offline run.
- Report an entry point you could not drive with the command and the unmet precondition. Do not report it as verified through another entry point.

## Feature entry contract

Each feature file has an H1, a one-paragraph description, and these H2s in order: `Sub-features`, `How to get to it (user POV)`, `Driving it with ctl.sh`, `Gotchas`.

## Features

- [Init](./init.md): create the storage zone and pull zone and write `orbitpush.json`, interactively or with flags, including cleanup when it fails.
- [Deploy](./deploy.md): upload changed files, delete stale files, purge, rerun with nothing changed, and safe failure.
- [Edge rules](./edge-rules.md): `redirects` and `headers` in `orbitpush.json` become managed rules; unsupported entries warn; dashboard rules stay.
- [Settings](./settings.md): SPA mode (from `redirects`) and the 404 page, replication regions, delivery regions, custom domains with SSL, and trailing slashes, re-applied on every deploy.
- [Migrate from Netlify](./migrate-netlify.md): `migrate-netlify` copies `netlify.toml`, `_redirects` and `_headers` into `orbitpush.json`, offline only, no bunny.net request.
- [Availability](./availability.md): `disable`, `enable` and `destroy`, each run twice to show they converge.
- [CLI basics](./cli-basics.md): help, version, unknown commands, missing key or config, and exit codes.
