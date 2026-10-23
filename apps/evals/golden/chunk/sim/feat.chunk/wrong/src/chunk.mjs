export function chunk(xs, size) {
  if (size < 1) return [];
  const out = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}
