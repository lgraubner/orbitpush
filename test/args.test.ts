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
      "--spa",
      "-y",
    ]),
  ).toMatchObject({
    command: "init",
    flags: {
      name: "site",
      domain: "www.a.test",
      alias: ["a.test", "b.test"],
      spa: true,
      yes: true,
    },
  });
});

test("leaves --spa undefined when neither --spa nor --no-spa is given", () => {
  expect(parseArgs(["init"]).flags.spa).toBeUndefined();
  expect(parseArgs(["init", "--no-spa"]).flags.spa).toBe(false);
});

test.each(["region", "domain"])("rejects --%s when it is given twice", (flag) => {
  expect(() => parseArgs(["init", `--${flag}`, "a", `--${flag}`, "b"])).toThrow(flag);
});
