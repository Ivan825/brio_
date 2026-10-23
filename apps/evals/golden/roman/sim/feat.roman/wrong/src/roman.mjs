const T = [
  [1000, "M"],
  [500, "D"],
  [100, "C"],
  [50, "L"],
  [10, "X"],
  [9, "IX"],
  [5, "V"],
  [4, "IV"],
  [1, "I"],
];
export function toRoman(n) {
  let out = "";
  for (const [v, s] of T)
    while (n >= v) {
      out += s;
      n -= v;
    }
  return out;
}
