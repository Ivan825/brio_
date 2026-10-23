export function deepClone(x) {
  if (x instanceof Date) return new Date(x.getTime());
  if (Array.isArray(x)) return x.map(deepClone);
  if (x && typeof x === "object")
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, deepClone(v)]));
  return x;
}
