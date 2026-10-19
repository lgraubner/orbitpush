import mri from "mri";

import { issues, z } from "./zod.ts";

const Argv = z.object({
  _: z.array(z.union([z.string(), z.number()])),
  help: z.optional(z.boolean()),
  version: z.optional(z.boolean()),
  yes: z.optional(z.boolean()),
  "prune-hostnames": z.optional(z.boolean()),
  name: z.optional(z.string()),
  dir: z.optional(z.string()),
  region: z.optional(z.string()),
  domain: z.optional(z.string()),
  alias: z.optional(z.union([z.string(), z.array(z.string())])),
  "replication-region": z.optional(z.union([z.string(), z.array(z.string())])),
  "delivery-region": z.optional(z.union([z.string(), z.array(z.string())])),
});

const OPTIONS = {
  boolean: ["help", "version", "yes", "prune-hostnames"],
  string: ["name", "dir", "domain", "alias", "region", "replication-region", "delivery-region"],
  alias: { h: "help", v: "version", y: "yes" },
};
const KNOWN = new Set(["_", ...OPTIONS.boolean, ...OPTIONS.string, ...Object.keys(OPTIONS.alias)]);

export function parseArgs(argv: string[]) {
  const parsed: Record<string, unknown> = mri(argv, structuredClone(OPTIONS));
  const unknown = Object.keys(parsed).find((key) => !KNOWN.has(key));
  if (unknown) {
    const flag = `${unknown.length === 1 ? "-" : "--"}${unknown}`;
    throw new Error(`Unknown option ${flag}. Run \`orbitpush --help\` for the options.`);
  }

  const result = Argv.safeParse(parsed);
  if (!result.success) {
    const problems = issues(result.error).map((issue) => `--${issue}`);
    throw new Error(`Invalid arguments: ${problems.join("; ")}`);
  }

  const { _: positionals, help, version, ...flags } = result.data;
  const [command] = positionals.map(String);

  return { command, help, version, flags };
}
