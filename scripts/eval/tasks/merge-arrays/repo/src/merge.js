function isObject(value) {
  return value !== null && typeof value === "object";
}

export function deepMerge(base, override) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const key of Object.keys(override)) {
    const bv = out[key];
    const ov = override[key];
    if (isObject(bv) && isObject(ov)) {
      out[key] = deepMerge(bv, ov);
    } else {
      out[key] = ov;
    }
  }
  return out;
}
