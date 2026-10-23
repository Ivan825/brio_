export function page(items, n, size) {
  const start = (n - 1) * size;
  return items.slice(start, start + size);
}
