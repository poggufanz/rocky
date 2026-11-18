import type { CardsForFile, StoredBlock, StoredCard } from "../desk/cards-read.js";

export type CardMatch = "symbol" | "line" | "file";

export interface CardTeachHit {
  card: StoredCard;
  block: StoredBlock;
  match: CardMatch;
}

interface Candidate {
  card: StoredCard;
  block: StoredBlock;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isNewerCandidate(candidate: Candidate, current: Candidate): boolean {
  if (candidate.card.started_ms !== current.card.started_ms) {
    return candidate.card.started_ms > current.card.started_ms;
  }
  return candidate.block.seq > current.block.seq;
}

function collectCandidates(found: CardsForFile): Candidate[] {
  const cardById = new Map<string, StoredCard>();
  for (const card of found.cards) {
    cardById.set(card.card_id, card);
  }
  const candidates: Candidate[] = [];
  for (const [cardId, blocks] of found.matched) {
    const card = cardById.get(cardId);
    if (card === undefined) continue;
    for (const block of blocks) {
      candidates.push({ card, block });
    }
  }
  return candidates;
}

function pickNewest(
  candidates: readonly Candidate[],
  predicate: (candidate: Candidate) => boolean,
): Candidate | undefined {
  let best: Candidate | undefined;
  for (const candidate of candidates) {
    if (!predicate(candidate)) continue;
    if (best === undefined || isNewerCandidate(candidate, best)) {
      best = candidate;
    }
  }
  return best;
}

function matchBySymbol(candidates: readonly Candidate[], snippet: string): CardTeachHit | undefined {
  const patterns = new Map<string, RegExp>();
  const best = pickNewest(candidates, ({ block }) => {
    const name = block.symbol?.name;
    if (name === undefined || name.length === 0) return false;
    let pattern = patterns.get(name);
    if (pattern === undefined) {
      pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`);
      patterns.set(name, pattern);
    }
    return pattern.test(snippet);
  });
  if (best === undefined) return undefined;
  return { card: best.card, block: best.block, match: "symbol" };
}

function matchByLine(candidates: readonly Candidate[], line: number): CardTeachHit | undefined {
  const best = pickNewest(candidates, ({ block }) => {
    if (block.symbol !== undefined && block.symbol !== null) return false;
    if (block.line === undefined || block.line === null) return false;
    const endLine = block.line + Math.max((block.added ?? 1) - 1, 0);
    return line >= block.line && line <= endLine;
  });
  if (best === undefined) return undefined;
  return { card: best.card, block: best.block, match: "line" };
}

/**
 * Match a teach selection against change card blocks for a single file,
 * preferring symbol name, then hunk line range (blocks without a symbol),
 * then newest block for whole-file queries.
 */
export function teachFromCards(
  found: CardsForFile,
  query: { snippet?: string; line?: number },
): CardTeachHit | undefined {
  const candidates = collectCandidates(found);
  if (candidates.length === 0) return undefined;

  if (query.snippet !== undefined && query.snippet.length > 0) {
    const symbolHit = matchBySymbol(candidates, query.snippet);
    if (symbolHit !== undefined) return symbolHit;
  }

  if (query.line !== undefined) {
    const lineHit = matchByLine(candidates, query.line);
    if (lineHit !== undefined) return lineHit;
  }

  if (query.snippet === undefined && query.line === undefined) {
    const fileHit = pickNewest(candidates, () => true);
    if (fileHit !== undefined) {
      return { card: fileHit.card, block: fileHit.block, match: "file" };
    }
  }

  return undefined;
}
