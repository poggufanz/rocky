import {
  calleeNames,
  collectImports,
  findDefinitionInText,
  isRelativeSpecifier,
  resolveRelativePath,
} from "./teach-ladder.js";

export interface ReferPosition {
  line: number;
  character: number;
}

export interface ReferRange {
  start: ReferPosition;
  end: ReferPosition;
}

export type ReferConfidence = "witnessed" | "heuristic";

export interface ReferHit {
  path: string;
  line: number;
  range: ReferRange;
  selectionRange: ReferRange;
  text: string;
  confidence: ReferConfidence;
  jsdoc?: string;
}

export interface ReferWitness {
  path: string;
  line: number;
  text: string;
}

export interface ReferResult {
  symbol: string;
  definition: ReferHit | null;
  references: ReferHit[];
}

export const REFER_MAX = 20;
export const REFER_TEXT_CAP = 120;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface ResolvedNeighbor {
  path: string;
  text: string;
}

function tryReadNeighbor(
  readNeighbor: (rel: string) => string | undefined,
  rel: string,
): ResolvedNeighbor | undefined {
  const candidates: string[] = [rel];
  if (rel.endsWith(".js")) {
    candidates.push(`${rel.slice(0, -3)}.ts`);
  }
  if (!/\.[a-z0-9]+$/i.test(rel)) {
    candidates.push(`${rel}.ts`, `${rel}.js`);
  }
  for (const cand of candidates) {
    const text = readNeighbor(cand);
    if (text !== undefined) {
      return { path: cand, text };
    }
  }
  return undefined;
}

export function resolveRefer(args: {
  path: string;
  fileText: string;
  line: number;
  symbol?: string;
  readNeighbor?: (rel: string) => string | undefined;
  texts?: ReadonlyMap<string, string>;
  witnesses?: readonly ReferWitness[];
}): ReferResult {
  let symbol = "";
  if (typeof args.symbol === "string" && args.symbol.trim().length > 0) {
    symbol = args.symbol.trim();
  } else {
    const lines = args.fileText.split(/\r?\n/);
    const lineIndex = args.line - 1;
    const lineText = lineIndex >= 0 && lineIndex < lines.length ? (lines[lineIndex] ?? "") : "";
    const callees = calleeNames(lineText);
    symbol = callees[0] ?? "";
  }

  if (symbol.length === 0) {
    return { symbol: "", definition: null, references: [] };
  }

  const symbolRe = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);

  let definition: ReferHit | null = null;
  const inFile = findDefinitionInText(symbol, args.fileText);
  if (inFile !== undefined) {
    const lines = args.fileText.split(/\r?\n/);
    const defLine = lines[inFile.line - 1] ?? "";
    const match = symbolRe.exec(defLine);
    const col = match !== null ? match.index : Math.max(0, defLine.indexOf(symbol));
    definition = {
      path: args.path,
      line: inFile.line,
      range: {
        start: { line: inFile.line, character: 0 },
        end: { line: inFile.line, character: defLine.length },
      },
      selectionRange: {
        start: { line: inFile.line, character: col },
        end: { line: inFile.line, character: col + symbol.length },
      },
      text: defLine.trim().slice(0, REFER_TEXT_CAP),
      confidence: "heuristic",
      ...(inFile.jsdoc !== undefined ? { jsdoc: inFile.jsdoc } : {}),
    };
  } else {
    const imports = collectImports(args.fileText);
    const imp = imports.find((i) => i.names.includes(symbol));
    if (imp !== undefined && isRelativeSpecifier(imp.specifier) && args.readNeighbor !== undefined) {
      const rel = resolveRelativePath(args.path, imp.specifier);
      const neighbor = tryReadNeighbor(args.readNeighbor, rel);
      if (neighbor !== undefined) {
        const found = findDefinitionInText(symbol, neighbor.text);
        if (found !== undefined) {
          const neighborLines = neighbor.text.split(/\r?\n/);
          const defLine = neighborLines[found.line - 1] ?? "";
          const match = symbolRe.exec(defLine);
          const col = match !== null ? match.index : Math.max(0, defLine.indexOf(symbol));
          definition = {
            path: neighbor.path,
            line: found.line,
            range: {
              start: { line: found.line, character: 0 },
              end: { line: found.line, character: defLine.length },
            },
            selectionRange: {
              start: { line: found.line, character: col },
              end: { line: found.line, character: col + symbol.length },
            },
            text: defLine.trim().slice(0, REFER_TEXT_CAP),
            confidence: "heuristic",
            ...(found.jsdoc !== undefined ? { jsdoc: found.jsdoc } : {}),
          };
        }
      }
    }
  }

  const references: ReferHit[] = [];
  const seenKeys = new Set<string>();
  if (definition !== null) {
    seenKeys.add(`${definition.path}:${definition.line}`);
  }

  if (args.witnesses !== undefined) {
    for (const w of args.witnesses) {
      if (references.length >= REFER_MAX) break;
      const key = `${w.path}:${w.line}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      const lineText = w.text;
      const match = symbolRe.exec(lineText);
      const col = match !== null ? match.index : Math.max(0, lineText.indexOf(symbol));
      const endCol = col + (lineText.includes(symbol) ? symbol.length : 0);

      references.push({
        path: w.path,
        line: w.line,
        range: {
          start: { line: w.line, character: 0 },
          end: { line: w.line, character: lineText.length },
        },
        selectionRange: {
          start: { line: w.line, character: col },
          end: { line: w.line, character: endCol },
        },
        text: lineText.trim().slice(0, REFER_TEXT_CAP),
        confidence: "witnessed",
      });
    }
  }

  if (args.texts !== undefined && references.length < REFER_MAX) {
    for (const [filePath, content] of args.texts.entries()) {
      if (references.length >= REFER_MAX) break;
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (references.length >= REFER_MAX) break;
        const rawLine = lines[i] ?? "";
        const match = symbolRe.exec(rawLine);
        if (match === null) continue;

        const lineNum = i + 1;
        const key = `${filePath}:${lineNum}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);

        const col = match.index;
        references.push({
          path: filePath,
          line: lineNum,
          range: {
            start: { line: lineNum, character: 0 },
            end: { line: lineNum, character: rawLine.length },
          },
          selectionRange: {
            start: { line: lineNum, character: col },
            end: { line: lineNum, character: col + symbol.length },
          },
          text: rawLine.trim().slice(0, REFER_TEXT_CAP),
          confidence: "heuristic",
        });
      }
    }
  }

  return {
    symbol,
    definition,
    references,
  };
}
