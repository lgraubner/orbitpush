---
name: release
description: Open a release PR that versions the Unreleased changelog entries and bumps package.json.
disable-model-invocation: true
---

# Release

The changelog decides the version. Merging the PR publishes it: on every push to `main`, the Publish job in `.github/workflows/ci.yml` runs `npm publish` when `package.json` holds a version npm does not have yet.

This invocation grants a `release/<version>` branch, its commit and push, and the PR. Merging, tags, and `npm publish` stay with the user.

## Steps

1. Run `git fetch origin`. The last release is the newest commit from `git log --grep '^chore(release)' origin/main`.
2. Reconcile the changelog with the commits since the last release: every `feat`, `fix`, or `!` commit that changes commands, flags, exit codes, terminal output, or the `orbitpush.json` format has its entry under `## Unreleased` in `CHANGELOG.md`. If an entry is missing, or `## Unreleased` is empty, stop and ask the user, listing the commits without an entry.
3. Choose the version from the entries under `## Unreleased`:

   | Entries                                       | Below 1.0 | 1.0 and up |
   | --------------------------------------------- | --------- | ---------- |
   | Any `**Breaking:**` entry                     | minor     | major      |
   | `Added`, `Changed`, `Deprecated` or `Removed` | minor     | minor      |
   | Only `Fixed` or `Security`                    | patch     | patch      |

   Read each entry as a user upgrading: an entry that makes their working command, flag, exit code, or `orbitpush.json` fail is breaking, whatever its heading says. Ask the user before adding the missing `**Breaking:**` marker.

4. Branch `release/<version>` from `origin/main`. Run `npm version <version> --no-git-tag-version`, which updates `package.json` and `package-lock.json`. In `CHANGELOG.md`, insert `## <version> - <YYYY-MM-DD>` with today's date directly below `## Unreleased`, so the entries move under the new version.
5. Make the gate green as "Done" in `CLAUDE.md` says, and confirm `node dist/cli.js --version` prints the new version. The diff touches exactly those three files.
6. Commit `chore(release): <version>`, push, and open the PR with `file-pr` under the same title. The description gives the row from step 3 that set the version with the entry that decided it, one line per entry with its PR number, the line `Merging publishes orbitpush@<version> to npm.`, and the gate output.
7. Report the PR link, the version, and the open issues from `gh issue list` that describe a bug shipping in this release. Bugs here are often unlabeled, so read the titles.
