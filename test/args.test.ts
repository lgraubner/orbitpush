import { expect, test } from "vitest";

import { parseArgs } from "../src/args.ts";

test("parses a command with its flags", () => {
  expect(
    parseArgs([
      "init",
      "--name",
      "site",
      "--domain",
      "a.test",
      "--domain",
      "b.test",
      "--spa",
      "-y",
    ]),
  ).toMatchObject({
    command: "init",
    flags: { name: "site", domain: ["a.test", "b.test"], spa: true, yes: true },
  });
});

test("leaves --spa undefined when neither --spa nor --no-spa is given", () => {
  expect(parseArgs(["init"]).flags.spa).toBeUndefined();
  expect(parseArgs(["init", "--no-spa"]).flags.spa).toBe(false);
});

test("rejects a flag that takes one value when it is given twice", () => {
  expect(() => parseArgs(["init", "--region", "DE", "--region", "NY"])).toThrow(/region/);
});
