import { stripVTControlCharacters } from "node:util";

import { afterEach, expect, test, vi } from "vitest";

import { log } from "../src/log.ts";

const isTTY = process.stderr.isTTY;

afterEach(() => {
  process.stderr.isTTY = isTTY;
  vi.restoreAllMocks();
});

test("log.status shows a transient line on a TTY that the next line clears", () => {
  process.stderr.isTTY = true;
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  log.status("Uploading");
  const status = stderr.mock.calls.join("");
  log.step("Done");

  const output = stderr.mock.calls.join("");
  expect(stripVTControlCharacters(status)).toBe("Uploading…");
  expect(output.slice(status.length)).toMatch(/^\r\x1b\[2K.*Done\n$/s);
});

test("log.status writes nothing without a TTY", () => {
  process.stderr.isTTY = false;
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  log.status("Uploading");

  expect(stderr).not.toHaveBeenCalled();
});
