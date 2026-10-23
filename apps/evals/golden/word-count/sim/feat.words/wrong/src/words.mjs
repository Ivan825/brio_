export function countWords(text) {
  const m = new Map();
  for (const w of text.toLowerCase().split(/\W+/).filter(Boolean)) m.set(w, (m.get(w) ?? 0) + 1);
  return m;
}
