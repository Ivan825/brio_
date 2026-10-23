export function parseLine(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (const c of line) {
    if (c === '"') quoted = !quoted;
    else if (c === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}
