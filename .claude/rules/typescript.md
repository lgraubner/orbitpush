---
paths: ["**/*.ts", "**/*.tsx"]
---

# TypeScript

## Blank lines

oxfmt never adds blank lines, so write function bodies in **paragraphs**, one per logical step, separated by a blank line:

- A statement and the check on its result form one paragraph: `const user = await getUser(id)` sits directly above `if (!user)`.
- A blank line follows each closing `}` when more statements follow.
- A blank line precedes an `if`, `for`, `switch`, or `try` that starts a new step, and the final `return` of a function with several steps.

## Comments

A one-line comment uses `//` and starts with a capital letter. `/**` opens only a multi-line docblock, with `/**` and `*/` on lines of their own and `*` leading each line between.

## Parsing

Every parser is a [zod](https://zod.dev) schema, and the type comes from it with `z.infer`, so the schema and the type cannot drift. Only a grammar for free-form text, such as `_redirects` and `_headers`, keeps a hand-written parser. Import `z` from `@/zod.ts`, which re-exports `zod/mini` with English error messages: wrap with functions (`z.optional(z.string())`, `z._default()`) instead of the chained methods of full `zod`.

## Tests

- Prefer static imports and `vi.spyOn` for small mocks.
- Use `vi.mock` only for module replacement or import-time side effects. Do not combine it with `vi.importActual`.
