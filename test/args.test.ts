import { expect, test } from "vitest";

import { parseArgs } from "../src/args.ts";

test("parses a command with its flags", () => {
  expect(
    parseArgs([
      "init",
      "--name",
      "site",
      "--domain",
      "www.a.test",
      "--alias",
      "a.test",
      "--alias",
      "b.test",
      "-y",
    ]),
  ).toMatchObject({
    command: "init",
    flags: {
      name: "site",
      domain: "www.a.test",
      alias: ["a.test", "b.test"],
      yes: true,
    },
  });
});

test.each(["region", "domain"])("rejects --%s when it is given twice", (flag) => {
  expect(() => parseArgs(["init", `--${flag}`, "a", `--${flag}`, "b"])).toThrow(flag);
});
