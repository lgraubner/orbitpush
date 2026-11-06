import { registerHooks } from "node:module";

// Node does not read the paths in tsconfig.json, so this maps @/ to src/ the same way
const src = new URL("../src/", import.meta.url);

registerHooks({
  resolve: (specifier, context, nextResolve) =>
    nextResolve(
      specifier.startsWith("@/") ? new URL(specifier.slice(2), src).href : specifier,
      context,
    ),
});
