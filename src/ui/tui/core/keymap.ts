export interface Binding { keys: string[]; when: string; action: string; help: string }

/** First layer in `layers` that binds `key` wins; layers are most-specific-first. */
export function resolveKey(bindings: Binding[], layers: string[], key: string): string | undefined {
  for (const layer of layers) {
    const hit = bindings.find((b) => b.when === layer && b.keys.includes(key));
    if (hit) return hit.action;
  }
  return undefined;
}

/** Help is generated, never hand-written — the fix for hint/help drift. */
export function helpLines(bindings: Binding[], layers: string[]): Array<{ layer: string; keys: string; help: string }> {
  const out: Array<{ layer: string; keys: string; help: string }> = [];
  for (const layer of layers) {
    for (const b of bindings) {
      if (b.when !== layer) continue;
      out.push({ layer, keys: b.keys.join("/"), help: b.help });
    }
  }
  return out;
}

export function assertNoConflicts(bindings: Binding[]): void {
  const seen = new Map<string, string>();
  for (const b of bindings) {
    for (const k of b.keys) {
      const id = `${b.when} ${k}`;
      const prior = seen.get(id);
      if (prior !== undefined && prior !== b.action) {
        throw new Error(`key "${k}" bound twice in layer "${b.when}": ${prior} vs ${b.action}`);
      }
      seen.set(id, b.action);
    }
  }
}
