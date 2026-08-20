/** Byte-safe UTF-8 slicing helpers shared by memory writers and hook capture. */

function utf8Width(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/**
 * Byte-bounded UTF-8 slice that never splits a code point. `startByte` skips
 * whole code points up to that byte offset; `maxBytes` caps the slice.
 */
export function utf8Slice(value: string, startByte: number, maxBytes: number): string {
  let bytes = 0;
  let offset = 0;
  while (offset < value.length && bytes < startByte) {
    const codePoint = value.codePointAt(offset) ?? 0;
    const width = utf8Width(codePoint);
    if (bytes + width > startByte) break;
    bytes += width;
    offset += codePoint > 0xffff ? 2 : 1;
  }
  const start = offset;
  bytes = 0;
  while (offset < value.length) {
    const codePoint = value.codePointAt(offset) ?? 0;
    const width = utf8Width(codePoint);
    if (bytes + width > maxBytes) break;
    bytes += width;
    offset += codePoint > 0xffff ? 2 : 1;
  }
  return value.slice(start, offset);
}

/** Return a bounded UTF-8 prefix without measuring or copying the full input. */
export function utf8Prefix(value: string, maxBytes: number): string {
  return utf8Slice(value, 0, maxBytes);
}

/** Byte-bounded UTF-8 suffix that never splits a code point or surrogate pair. */
export function utf8SliceFromEnd(value: string, maxBytes: number): string {
  let bytes = 0;
  let offset = value.length;
  while (offset > 0) {
    let start = offset - 1;
    const code = value.charCodeAt(start);
    if (code >= 0xdc00 && code <= 0xdfff && start > 0) {
      const high = value.charCodeAt(start - 1);
      if (high >= 0xd800 && high <= 0xdbff) start -= 1;
    }
    const width = utf8Width(value.codePointAt(start) ?? 0);
    if (bytes + width > maxBytes) break;
    bytes += width;
    offset = start;
  }
  return value.slice(offset);
}
