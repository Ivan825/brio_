const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);
export function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = plain(v) && plain(a[k]) ? deepMerge(a[k], v) : v;
  return out;
}
