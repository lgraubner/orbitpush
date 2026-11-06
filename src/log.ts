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
    // Erase in Line clears only the cursor's row, so auto-wrap (DECAWM) is off while the line is written and the terminal clips it to one row
    process.stderr.write(`\x1b[?7l${style("dim", `${text}…`)}\x1b[?7h`);
    statusShown = true;
  },
};

export function count(n: number, noun: string) {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
