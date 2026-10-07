/**
 * P0 wizard selection shell (spec sections 3 and 8 gate 3).
 * Selection UI only: returns structured selections, no adapter wiring.
 * All I/O on the injected output stream (production: process.stderr).
 */

import type { SetupOptions } from "./clients.js";
import { HARNESS_IDS, type HarnessId } from "./harness-registry.js";
import type { PromptPort } from "./prompt.js";

export interface HarnessFeatureSelection {
  id: HarnessId;
  mcp: boolean;
  listening: boolean;
}

export interface HarnessWizardResult {
  cancelled: boolean;
  selections: HarnessFeatureSelection[];
}

export interface HarnessWizardStreams {
  input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => void };
  output: NodeJS.WritableStream;
}

const UP = "\u001b[A";
const DOWN = "\u001b[B";
const ESC = "\u001b";
const CTRL_C = "\u0003";
const ENTER = "\r";
const SPACE = " ";

function writeLine(output: NodeJS.WritableStream, line: string): void {
  output.write(`${line}\n`);
}

const MENU_CHROME_LINES = 2; // title + hint around the rows

function renderMenu(
  output: NodeJS.WritableStream,
  title: string,
  rows: readonly string[],
  checked: ReadonlySet<number>,
  cursor: number,
): void {
  writeLine(output, title);
  rows.forEach((row, index) => {
    const mark = checked.has(index) ? "[x]" : "[ ]";
    const pointer = index === cursor ? ">" : " ";
    writeLine(output, `${pointer} ${mark} ${row}`);
  });
  writeLine(output, "Up/Down move, Space toggle, Enter accept, Esc cancel");
}

/** Rewind over the previous draw so the menu updates in place; TTY output only. */
function rewindMenu(output: NodeJS.WritableStream, rowCount: number): void {
  if ((output as { isTTY?: boolean }).isTTY !== true) return;
  output.write(`\u001b[${rowCount + MENU_CHROME_LINES}A\u001b[J`);
}

interface KeyReader {
  readKey(): Promise<string | undefined>;
  close(): void;
}

function createKeyReader(input: HarnessWizardStreams["input"]): KeyReader {
  let buffer = "";
  let waiter: ((key: string) => void) | undefined;
  const onData = (chunk: unknown): void => {
    buffer += String(chunk);
    if (waiter !== undefined) {
      const emit = waiter;
      waiter = undefined;
      emit(buffer);
      buffer = "";
    }
  };
  input.on("data", onData);
  return {
    readKey: () => new Promise<string | undefined>((resolve) => {
      if (buffer.length > 0) {
        const key = buffer;
        buffer = "";
        resolve(key);
        return;
      }
      waiter = (key) => resolve(key);
    }),
    close: () => { input.removeListener("data", onData); },
  };
}

async function multiSelect(
  input: HarnessWizardStreams["input"],
  output: NodeJS.WritableStream,
  title: string,
  rows: readonly string[],
): Promise<{ cancelled: boolean; checked: number[] }> {
  const checked = new Set<number>();
  let cursor = 0;
  const rawCapable = typeof input.setRawMode === "function";
  if (rawCapable) input.setRawMode!(true);
  const reader = createKeyReader(input);
  let drawn = false;
  try {
    for (;;) {
      if (drawn) rewindMenu(output, rows.length);
      renderMenu(output, title, rows, checked, cursor);
      drawn = true;
      const key = await reader.readKey();
      if (key === undefined || key === CTRL_C || key === ESC) return { cancelled: true, checked: [] };
      if (key === UP) cursor = (cursor + rows.length - 1) % rows.length;
      else if (key === DOWN) cursor = (cursor + 1) % rows.length;
      else if (key === SPACE) {
        if (checked.has(cursor)) checked.delete(cursor);
        else checked.add(cursor);
      } else if (key === ENTER || key === "\n") return { cancelled: false, checked: [...checked].sort((a, b) => a - b) };
    }
  } finally {
    reader.close();
    if (rawCapable) input.setRawMode!(false);
  }
}

async function numberedFallback(
  prompt: PromptPort,
  output: NodeJS.WritableStream,
  title: string,
  rows: readonly string[],
): Promise<{ cancelled: boolean; checked: number[] }> {
  writeLine(output, title);
  rows.forEach((row, index) => { writeLine(output, `  ${index + 1}) ${row}`); });
  writeLine(output, "Enter numbers separated by commas, 0=cancel");
  const answer = await prompt.ask("choose: ");
  if (answer === undefined) return { cancelled: true, checked: [] };
  const trimmed = answer.trim();
  if (trimmed === "0" || trimmed === "") return { cancelled: true, checked: [] };
  const picked = new Set<number>();
  for (const part of trimmed.split(",")) {
    const slot = Number(part.trim());
    if (!Number.isInteger(slot) || slot < 1 || slot > rows.length) return { cancelled: true, checked: [] };
    picked.add(slot - 1);
  }
  return { cancelled: false, checked: [...picked].sort((a, b) => a - b) };
}

/**
 * Map picker output onto setup options. Only MCP-selected hosts reach the
 * adapters; setup has no per-harness Listening step yet, so those picks are
 * reported by the caller instead of silently widening the host set.
 */
export function selectionsToSetupOptions(
  options: SetupOptions,
  selections: readonly HarnessFeatureSelection[],
): SetupOptions {
  const mcpIds = selections.filter((selection) => selection.mcp).map((selection) => selection.id);
  return {
    ...options,
    harnesses: mcpIds,
    harness: mcpIds,
    mcp: mcpIds.length > 0,
    listening: selections.some((selection) => selection.listening),
    wizard: false,
  };
}

export async function runHarnessWizard(
  prompt: PromptPort,
  streams: HarnessWizardStreams = { input: process.stdin, output: process.stderr },
  ids: readonly HarnessId[] = HARNESS_IDS,
): Promise<HarnessWizardResult> {
  const { input, output } = streams;
  const rows = [...ids];
  const canRaw = typeof input.setRawMode === "function" && input.isTTY === true;
  const pick = canRaw
    ? await multiSelect(input, output, "Select your Harness", rows)
    : input.isTTY === true
      ? await numberedFallback(prompt, output, "Select your Harness", rows)
      : { cancelled: true, checked: [] };
  if (pick.cancelled || pick.checked.length === 0) return { cancelled: true, selections: [] };

  // ponytail: no per-host MCP/Listening phase; setup has no Listening step per
  // harness yet, so every pick is MCP. Restore the phase when that step lands.
  const selections = pick.checked.map((rowIndex): HarnessFeatureSelection => (
    { id: rows[rowIndex]!, mcp: true, listening: false }
  ));
  return { cancelled: false, selections };
}
