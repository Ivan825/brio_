// Splits a unified git diff into files and hunks for the diff viewer. Pure; tolerant of what it does not know.

export interface DiffLine {
  kind: "add" | "del" | "ctx" | "meta";
  text: string;
  /** Line numbers in the old and new file (null where the line does not exist there). */
  old: number | null;
  new: number | null;
}

export interface DiffFile {
  path: string;
  /** The old path when the file was renamed. */
  from: string | null;
  status: "added" | "deleted" | "modified" | "renamed" | "binary";
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

const strip = (p: string) => p.replace(/^[ab]\//, "");

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let f: DiffFile | null = null;
  let o = 0;
  let n = 0;
  for (const raw of text.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(raw);
      f = {
        path: m?.[2] ?? raw.slice(11),
        from: null,
        status: "modified",
        additions: 0,
        deletions: 0,
        lines: [],
      };
      files.push(f);
      continue;
    }
    if (!f) continue;
    if (raw.startsWith("new file mode")) f.status = "added";
    else if (raw.startsWith("deleted file mode")) f.status = "deleted";
    else if (raw.startsWith("rename from ")) {
      f.from = raw.slice(12);
      f.status = "renamed";
    } else if (raw.startsWith("rename to ")) f.path = raw.slice(10);
    else if (raw.startsWith("Binary files ") || raw === "GIT binary patch") f.status = "binary";
    else if (raw.startsWith("--- ") || raw.startsWith("+++ ")) {
      const p = raw.slice(4);
      if (raw.startsWith("+++ ") && p !== "/dev/null") f.path = strip(p);
    } else if (raw.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      o = Number(m?.[1] ?? 0);
      n = Number(m?.[2] ?? 0);
      f.lines.push({ kind: "meta", text: raw, old: null, new: null });
    } else if (f.lines.length && f.status !== "binary") {
      if (raw.startsWith("+")) {
        f.additions++;
        f.lines.push({ kind: "add", text: raw.slice(1), old: null, new: n++ });
      } else if (raw.startsWith("-")) {
        f.deletions++;
        f.lines.push({ kind: "del", text: raw.slice(1), old: o++, new: null });
      } else if (raw.startsWith(" ")) f.lines.push({ kind: "ctx", text: raw.slice(1), old: o++, new: n++ });
      else if (raw.startsWith("\\")) f.lines.push({ kind: "meta", text: raw, old: null, new: null });
    }
  }
  return files;
}
