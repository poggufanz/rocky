/** Dependency-free UTC date and date-time formatters shared across core and CLI surfaces. */

export function formatUtcDate(ts: number): string {
  const d = new Date(ts);
  const year = String(d.getUTCFullYear()).padStart(4, "0");
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatUtcDateTime(ts: number): string {
  const d = new Date(ts);
  const hours = String(d.getUTCHours()).padStart(2, "0");
  const minutes = String(d.getUTCMinutes()).padStart(2, "0");
  return `${formatUtcDate(ts)} ${hours}:${minutes}`;
}
