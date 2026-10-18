---
name: typescript-best-practices
description: Use when writing or reviewing TypeScript types - a new type or interface, a cast, a type guard, a function signature, or untyped external data.
paths: ["**/*.ts", "**/*.tsx"]
license: MIT, adapted from pstack by Lauren Tan; see .claude/LICENSE-pstack
---

# TypeScript best practices

Read `.claude/principles/types-and-boundaries.md` first. It holds the modeling and boundary rules: unions, status fields, total types, branded IDs, parsing where data enters. This skill adds the TypeScript mechanics.

| Rule                  | Summary                                                                                                                                                                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Constructive modeling | Build the shape so the illegal value can't be constructed. `[T, ...T[]]` for non-empty, `[T, T][]` for even length, `start` plus `duration` for a range.                                                                                 |
| `unknown` over `any`  | External data is `unknown`.                                                                                                                                                                                                              |
| Narrowing hierarchy   | Discriminant switch > `in` operator > `typeof`/`instanceof` > user-defined type guard > `as`.                                                                                                                                            |
| Type guards           | Infer from a schema first (`z.infer`); hand-write a guard only where no schema fits. A guard must verify its claim. A lying guard is worse than `as` because the bug hides behind a name that says it's safe. Name them `isX` or `hasX`. |
| `satisfies` over `as` | Validates the value without widening literal types.                                                                                                                                                                                      |
| Schema-derived types  | Reach for `Pick`/`Omit`/`Parameters`/`ReturnType`/`Awaited`/`typeof` before declaring a new interface.                                                                                                                                   |
| Object args           | Pass objects, not positional, so argument order is self-documenting. Skip on hot paths (per-frame render, tokenizers, parsers).                                                                                                          |

`references/patterns.md` has an example for each rule here and in the principle, under the rule's name. Read the section before applying a rule you have not written before.

When reviewing, check the diff against every rule here and in the principle.
