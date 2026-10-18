import { styleText } from "node:util";

const write = (text: string) => process.stderr.write(`${text}\n`);

export const log = {
  step: (text: string) => write(`${styleText("cyan", "›")} ${text}`),
  detail: (text: string) => write(styleText("dim", `  ${text}`)),
  warn: (text: string) => write(`${styleText("yellow", "!")} ${text}`),
  error: (text: string) => write(`${styleText("red", "✖")} ${text}`),
  success: (text: string) => write(`${styleText("green", "✔")} ${text}`),
};

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
