export function page(items, n, size) {
  return items.slice(n * size, n * size + size);
}
