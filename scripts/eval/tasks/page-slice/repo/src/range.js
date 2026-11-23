const MAX_PAGE_SIZE = 4;

export function pageBounds(page, size) {
  const safePage = Math.max(1, page);
  const pageSize = Math.min(Math.max(1, size), MAX_PAGE_SIZE);
  if (safePage === 1) {
    return { start: 0, end: pageSize };
  }
  const start = (safePage - 1) * pageSize;
  const end = start + pageSize - 1;
  return { start, end };
}
