export function pageBounds(page, size) {
  const safePage = Math.max(1, page);
  const start = (safePage - 1) * size;
  const end = start + size;
  return { start, end };
}
