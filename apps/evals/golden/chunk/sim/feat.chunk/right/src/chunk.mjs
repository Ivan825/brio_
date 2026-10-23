export function chunk(xs, size) {
  if (!(size >= 1)) throw new RangeError("size must be at least 1");
  const out = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}
