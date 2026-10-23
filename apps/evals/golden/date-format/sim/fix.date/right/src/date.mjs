const pad = (n) => String(n).padStart(2, "0");
export function formatDate(d) {
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}
