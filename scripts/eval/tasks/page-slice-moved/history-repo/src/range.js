const MAX_PAGE_SIZE = 4;

export function pageBounds(page, size) {
  const safePage = Math.max(1, page);
  const pageSize = Math.min(Math.max(1, size), MAX_PAGE_SIZE);
  const start = (safePage - 1) * pageSize;
  if (safePage === 1 || pageSize === 1) {
    return { start, end: start + pageSize };
  }
  const end = start + pageSize - 1;
  return { start, end };
}
