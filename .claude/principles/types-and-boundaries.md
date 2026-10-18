# Types and boundaries

Make the compiler reject impossible states. Parse untrusted data once, where it enters, into a named domain type. Trust the types everywhere else.

## Model the domain

- Model variants as a discriminated union, not as a bag of optional fields. If a comment explains when a combination of fields is valid, split it into a union.
- Give each lifecycle one status field with a literal union instead of a second boolean that must stay in sync with the first.
- Prefer a lookup table or a `satisfies Record<Union, …>` map over an if/else chain that grows by one branch per feature.
- Keep the plain type while every operation on it stays total. Strengthen it only where the loose type forces a `!`, an `as`, or a "should never happen" branch.
- Brand an ID when two IDs of the same primitive type travel through the same call and can be swapped.
- Keep code boring when the shape is clear, local, and unlikely to grow. An abstraction earns its place by deleting branches, duplicated rules, or invalid states.

## Parse at the boundary

Boundaries: environment, network input (HTTP, WebSocket), queue payloads, external API responses, files, storage. The project's `CLAUDE.md` names its parser per boundary.

- Derive the type from the schema (`z.infer`), so the schema and the type cannot drift.
- Hand the parsed value on, not the raw input. Code behind the boundary takes the domain type and does not validate again.
- Expose domain types across a boundary, not the transport, storage, or wire types behind it.
- Resolve an `as` cast by finding the boundary it skips and parsing there. A cast is right only for a fact the type system cannot express, after validation.

## In this repo

- `parseArgs()` in `src/args.ts` parses the `mri` output, which is typed as `any`, so no flag reaches `init` unchecked.
- `readConfig()` in `src/config.ts` parses `orbitpush.json` with a `zod/mini` schema, and `Config` is `z.infer` of it. Unknown keys such as `$schema` are dropped.
- `Region` is derived from `STORAGE_REGIONS` and is the only place the region rule lives: `readConfig()` and `init()` both parse through it.
- bunny.net responses are parsed where they enter: `apiJson()` and `storage().list()` in `src/bunny.ts` take a schema and throw `bunny.net returned an unexpected response for ...` before any write follows.
- `EdgeRule` in `src/rules.ts` pins the wire constants bunny.net expects as literal types, such as `TriggerMatchingType: 0` and `Enabled: true`.

Adapted from pstack (MIT), see `.claude/LICENSE-pstack`.
