import { styleText } from "node:util";

let statusShown = false;

const clearStatus = () => {
  if (!statusShown) return;
  process.stderr.write("\r\x1b[2K");
  statusShown = false;
};
const write = (text: string) => {
  clearStatus();
  process.stderr.write(`${text}\n`);
};
// styleText decides on colors from process.stdout unless it is given the stream it writes to
export const style = (format: Parameters<typeof styleText>[0], text: string) =>
  styleText(format, text, { stream: process.stderr });

export const log = {
  step: (text: string) => write(`${style("cyan", "›")} ${text}`),
  detail: (text: string) => write(style("dim", `  ${text}`)),
  warn: (text: string) => write(`${style("yellow", "!")} ${text}`),
  error: (text: string) => write(`${style("red", "✖")} ${text}`),
  success: (text: string) => write(`${style("green", "✔")} ${text}`),
  status: (text: string) => {
    if (!process.stderr.isTTY) return;
    clearStatus();
    process.stderr.write(style("dim", `${text}…`));
    statusShown = true;
  },
};

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
