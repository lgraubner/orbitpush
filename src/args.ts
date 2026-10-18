import mri from "mri";

import { issues, z } from "./zod.ts";

const Argv = z.object({
  _: z.array(z.union([z.string(), z.number()])),
  help: z.optional(z.boolean()),
  version: z.optional(z.boolean()),
  yes: z.optional(z.boolean()),
  spa: z.optional(z.boolean()),
  name: z.optional(z.string()),
  dir: z.optional(z.string()),
  region: z.optional(z.string()),
  domain: z.optional(z.union([z.string(), z.array(z.string())])),
});

export function parseArgs(argv: string[]) {
  const result = Argv.safeParse(
    mri(argv, {
      boolean: ["help", "version", "yes", "spa"],
      string: ["name", "dir", "domain", "region"],
      alias: { h: "help", v: "version", y: "yes" },
    }),
  );
  if (!result.success) {
    const problems = issues(result.error).map((issue) => `--${issue}`);
    throw new Error(`Invalid arguments: ${problems.join("; ")}`);
  }

  const { _: positionals, help, version, ...flags } = result.data;
  const [command] = positionals.map(String);

  return { command, help, version, flags };
}
