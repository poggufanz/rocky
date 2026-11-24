export function memoize(fn) {
  const cache = new Map();
  return function memoized(...args) {
    const key = String(args[0]);
    if (cache.has(key)) return cache.get(key);
    const val = fn(...args);
    cache.set(key, val);
    return val;
  };
}
