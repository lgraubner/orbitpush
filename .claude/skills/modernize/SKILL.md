---
name: modernize
description: Bring an old PR up to date and decide whether it should still exist. Use when asked to rebase, refresh, or modernize a PR.
license: MIT, adapted from tstack by Theo Browne; see .claude/LICENSE-tstack
---

# Modernize

Modernize the idea, not just the branch. A clean rebase does not prove that the PR still belongs in the product.

## Guardrails

- Fetch the PR branch, its base, and any related branch before starting.
- Treat existing worktree changes as the user's. Use a separate worktree when the current one is dirty or in use.
- Modernizing authorizes rebasing and updating the PR branch. It does not authorize merging, closing, changing the base branch, or expanding scope.
- Push a rebased branch only with `--force-with-lease` against the head SHA observed before the rebase.
- Post a PR comment only when the user asked for one, in the format `babysit-pr` sets.

## Establish the PR's intent

Record the PR's URL, state, base, head branch, head SHA, author, checks, and review state. Read the title, body, linked issues, commits, review threads, and the complete diff. State the smallest coherent goal the PR was trying to reach before judging its implementation.

Record the merge base, so the PR's own changes and the base branch's later changes can be compared separately.

## Check what changed around it

Inspect the commits that landed on the base branch since the PR diverged. Search merged and open PRs when titles, code paths, or behavior suggest a replacement or a competing implementation.

Look beyond overlapping lines:

- Has the same user-facing problem already been solved?
- Did APIs, types, schemas, dependencies, or boundaries change?
- Do both sides now claim the same behavior or invariant?
- Was the code being changed deleted, moved, or deliberately simplified?
- Would landing the PR restore an old behavior or create two ways to do the same thing?
- Is the original benefit still worth the maintenance cost?

No conflicts in Git does not make a PR current.

## Choose a disposition before pushing

- **MODERNIZE**: the goal is still useful and the implementation is still the right shape. Rebase, resolve conflicts, check, and update the branch.
- **REWORK**: the goal is still useful, but a mechanical rebase would keep the wrong implementation. Describe the smallest credible rewrite and stop, unless the user also asked for the rework.
- **CLOSE**: the PR is superseded, obsolete, wrong in direction, or no longer worth its cost. Cite the evidence and stop. Do not rebase an obsolete branch, and do not close it without explicit permission.

Be willing to recommend CLOSE. Age alone is not evidence, and sunk effort is no reason to keep a PR alive.

## Rebase without losing intent

For MODERNIZE:

1. Create a local branch or worktree at the recorded PR head.
2. Rebase its commits onto the freshly fetched base branch.
3. Resolve each conflict by the PR's intent and the base branch's newer invariants. If a conflict reveals a product or architecture disagreement, stop and reconsider the disposition instead of guessing.
4. Compare the commit series before and after with `git range-diff`, and read the final diff. Confirm no intended behavior disappeared and no already-landed behavior came back.
5. Run the check command from `CLAUDE.md`. Tell real failures from pre-existing or infrastructure ones.
6. Push with `--force-with-lease` tied to the remote head observed before. If the lease fails, fetch and reassess instead of overwriting new work.

## Report

Lead with MODERNIZE, REWORK, or CLOSE and the reason. Then summarize:

- meaningful changes on the base branch;
- conceptual conflicts, or that none were found;
- the rebase and push result, if done;
- the checks run and their results;
- the remaining decision or work, with a link to the PR.

Separate observed facts from judgment, and name what could not be verified.
