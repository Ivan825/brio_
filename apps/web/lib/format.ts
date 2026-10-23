/** USD for machine data: small costs keep their precision ($0.000412), larger ones round to cents. */
export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n === 0) return "$0";
  if (Math.abs(n) < 0.01) return `$${n.toFixed(6).replace(/0+$/, "")}`;
  return `$${n.toFixed(2)}`;
}

/** Price per million tokens. */
export function perM(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return `$${Number(n.toFixed(4))}`;
}

export function tokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(2))}M`;
  if (n >= 1000) return `${Number((n / 1000).toFixed(1))}k`;
  return String(n);
}
