---
paths: ["**/*.test.ts", "**/*.test.tsx"]
---

# Vitest

- Prefer static imports and `vi.spyOn` for small mocks.
- Use `vi.mock` only for module replacement or import-time side effects. Do not combine it with `vi.importActual`.
