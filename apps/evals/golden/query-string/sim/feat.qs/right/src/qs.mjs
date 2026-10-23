export function stringify(obj) {
  const e = encodeURIComponent;
  return Object.entries(obj)
    .flatMap(([k, v]) =>
      v === undefined ? [] : Array.isArray(v) ? v.map((x) => `${e(k)}=${e(x)}`) : [`${e(k)}=${e(v)}`],
    )
    .join("&");
}
