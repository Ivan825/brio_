export function deepMerge(a, b) {
  for (const [k, v] of Object.entries(b)) a[k] = typeof v === "object" && a[k] ? deepMerge(a[k], v) : v;
  return a;
}
