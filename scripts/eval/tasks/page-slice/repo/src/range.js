export function pageBounds(page, size) {
  const safePage = Math.max(1, page);
  const start = (safePage - 1) * size;
  const end = start + size - 1;
  return { start, end };
}
