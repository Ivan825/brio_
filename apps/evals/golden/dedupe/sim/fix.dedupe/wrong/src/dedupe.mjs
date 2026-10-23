export const dedupe = (xs) => xs.filter((x, i) => xs.indexOf(x) === i);
