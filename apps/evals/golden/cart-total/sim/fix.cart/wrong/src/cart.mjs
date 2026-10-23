export function total(items, discountPct = 0) {
  const sum = items.reduce((s, i) => s + i.price * i.qty, 0);
  return Math.round(sum * 100) / 100;
}
