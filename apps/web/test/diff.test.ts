import { describe, expect, it } from "vitest";
import { parseDiff } from "../lib/diff";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
 export { a, b };
diff --git a/new.md b/new.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.md
@@ -0,0 +1,2 @@
+# New
+text
\\ No newline at end of file
diff --git a/old.txt b/renamed.txt
similarity index 100%
rename from old.txt
rename to renamed.txt
diff --git a/logo.png b/logo.png
new file mode 100644
Binary files /dev/null and b/logo.png differ
`;

describe("parseDiff", () => {
  it("splits files with their status, counts and numbered lines", () => {
    const files = parseDiff(DIFF);
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ["src/a.ts", "modified", 1, 1],
      ["new.md", "added", 2, 0],
      ["renamed.txt", "renamed", 0, 0],
      ["logo.png", "binary", 0, 0],
    ]);
    expect(files[2]?.from).toBe("old.txt");
    const a = files[0]?.lines ?? [];
    expect(a.map((l) => [l.kind, l.old, l.new])).toEqual([
      ["meta", null, null],
      ["ctx", 1, 1],
      ["del", 2, null],
      ["add", null, 2],
      ["ctx", 3, 3],
    ]);
    expect(files[1]?.lines.at(-1)?.kind).toBe("meta");
  });

  it("returns nothing for an empty diff", () => {
    expect(parseDiff("")).toEqual([]);
  });
});
