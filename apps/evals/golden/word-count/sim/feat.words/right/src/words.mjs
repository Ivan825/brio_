export function countWords(text) {
  const m = new Map();
  for (const w of text.toLowerCase().match(/[a-z0-9]+(?:['-][a-z0-9]+)*/g) ?? [])
    m.set(w, (m.get(w) ?? 0) + 1);
  return m;
}
