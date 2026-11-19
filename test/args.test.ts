import { expect, test } from "vitest";

import { parseArgs } from "../src/args.ts";

test("parses a command with its flags", () => {
  expect(parseArgs(["init", "--name", "site", "--dir", "dist", "-y"])).toMatchObject({
    command: "init",
    flags: {
      name: "site",
      dir: "dist",
      yes: true,
    },
  });
});

test.each(["region", "name"])("rejects --%s when it is given twice", (flag) => {
  expect(() => parseArgs(["init", `--${flag}`, "a", `--${flag}`, "b"])).toThrow(flag);
});

test.each([["--domian"], ["-x"], ["--domain"], ["--alias"]])(
  "rejects %s, which no command knows",
  (flag) => {
    expect(() => parseArgs(["init", flag, "www.a.test", "-y"])).toThrow(` ${flag}.`);
  },
);

test("parses --prune-hostnames for deploy", () => {
  expect(parseArgs(["deploy", "--prune-hostnames"])).toMatchObject({
    command: "deploy",
    flags: { "prune-hostnames": true },
  });
});

test("parses repeatable --replication-region and --delivery-region", () => {
  expect(
    parseArgs([
      "init",
      "--replication-region",
      "NY",
      "--replication-region",
      "SG",
      "--delivery-region",
      "EU",
    ]),
  ).toMatchObject({
    flags: { "replication-region": ["NY", "SG"], "delivery-region": "EU" },
  });
});
