export interface AxisItem { basis?: number; grow?: number; shrink?: number; min?: number; max?: number }

/**
 * Single-axis flex (spec §5.3). Fractional solve, clamp with up to three
 * redistribution passes, then largest-remainder rounding so results sum to
 * `inner` exactly — the property that keeps borders aligned at odd widths.
 */
export function solveAxis(inner: number, items: AxisItem[], gap = 0): number[] {
  const n = items.length;
  if (n === 0) return [];
  const avail = Math.max(0, inner - gap * (n - 1));
  let sizes = items.map((it) => it.basis ?? 0);
  const frozen = new Array<boolean>(n).fill(false);

  for (let pass = 0; pass < 3; pass++) {
    const free = avail - sizes.reduce((a, b) => a + b, 0);
    if (free > 0) {
      const growSum = items.reduce((a, it, i) => a + (frozen[i] ? 0 : it.grow ?? 0), 0);
      if (growSum > 0) sizes = sizes.map((s, i) => frozen[i] ? s : s + (free * (items[i].grow ?? 0)) / growSum);
    } else if (free < 0) {
      const shrinkSum = items.reduce((a, it, i) => a + (frozen[i] ? 0 : (it.shrink ?? 0) * (it.basis ?? 0)), 0);
      if (shrinkSum > 0) sizes = sizes.map((s, i) =>
        frozen[i] ? s : s + (free * ((items[i].shrink ?? 0) * (items[i].basis ?? 0))) / shrinkSum);
    }
    let clamped = false;
    sizes = sizes.map((s, i) => {
      const lo = items[i].min ?? 0;
      const hi = items[i].max ?? Infinity;
      const c = Math.min(hi, Math.max(lo, s));
      if (c !== s && !frozen[i]) { frozen[i] = true; clamped = true; }
      return c;
    });
    if (!clamped) break;
  }

  // largest-remainder rounding, keeping clamped items exact
  const floored = sizes.map((s) => Math.floor(s));
  let leftover = Math.min(avail, Math.round(sizes.reduce((a, b) => a + b, 0))) - floored.reduce((a, b) => a + b, 0);
  const order = sizes.map((s, i) => ({ i, frac: s - Math.floor(s) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (leftover <= 0) break;
    const hi = items[i].max ?? Infinity;
    if (floored[i] + 1 <= hi) { floored[i]++; leftover--; }
  }
  return floored.map((s) => Math.max(0, s));
}
