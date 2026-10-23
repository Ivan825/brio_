export function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .split(/[\s-]+/)
    .filter(Boolean)
    .join("-");
}
