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

- `readConfig()` in `src/config.ts` parses `orbitpush.json`, but casts with `JSON.parse(raw) as Config` before its hand-written checks, and keeps `region` and the region lists as `string`.
- The storage region rule is checked twice: in `readConfig()` and in `init()` (`src/init.ts`). A `Region` union derived from `STORAGE_REGIONS` would carry it once.
- `api<T>()` and `storage().list()` in `src/bunny.ts` cast bunny.net responses to `PullZone`, `StorageZone`, and the listing type without parsing them.
- `EdgeRule` in `src/rules.ts` pins the wire constants bunny.net expects as literal types, such as `TriggerMatchingType: 0` and `Enabled: true`.

Adapted from pstack (MIT), see `.claude/LICENSE-pstack`.
