// Builds docs/API.md from the API's route definitions: every route, the comment above it, and who may call it (the
// roles its handler requires, whether an API token may). `pnpm --filter @brio/api docs:api` writes it; a test fails
// when the committed file no longer matches the code.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface Route {
  method: string;
  path: string;
  doc: string;
  who: string;
}

const ROUTE = /\bapp\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g;

/** The JSDoc block ending just before `index`, as one line of prose. */
function docBefore(src: string, index: number): string {
  const before = src.slice(0, index).trimEnd();
  if (!before.endsWith("*/")) return "";
  const start = before.lastIndexOf("/**");
  if (start < 0) return "";
  return before
    .slice(start + 3, -2)
    .split("\n")
    .map((l) => l.replace(/^\s*\*\s?/, "").trim())
    .filter(Boolean)
    .join(" ");
}

/** Who may call a handler, read from its checks. */
function whoOf(body: string): string {
  const parts: string[] = [];
  const roles = /requireMember\([^)]*\[([^\]]+)\]/.exec(body)?.[1];
  if (/requireSession\(/.test(body))
    parts.push(
      roles
        ? roles
            .replace(/"/g, "")
            .split(",")
            .map((r) => r.trim())
            .join(", ")
        : "any member",
    );
  else parts.push("public");
  if (/requireSignedIn\(/.test(body)) parts.push("signed-in person only (no API token)");
  return parts.join("; ");
}

export function buildApiReference(apiSrc: string): string {
  const files = readdirSync(join(apiSrc, "routes"))
    .filter((f) => f.endsWith(".ts") && f !== "dev.ts")
    .sort()
    .map((f) => join(apiSrc, "routes", f))
    .concat(join(apiSrc, "a2a", "server.ts"));
  const sections: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const matches = [...src.matchAll(ROUTE)];
    if (!matches.length) continue;
    const routes: Route[] = matches.map((m, i) => {
      const end = matches[i + 1]?.index ?? src.length;
      const body = src.slice(m.index, end);
      return { method: m[1]!.toUpperCase(), path: m[2]!, doc: docBefore(src, m.index), who: whoOf(body) };
    });
    const name = file.endsWith(join("a2a", "server.ts"))
      ? "a2a"
      : file.split("/").pop()!.replace(/\.ts$/, "");
    const header = src.match(/^\/\/ (.+(?:\n\/\/ .+)*)/)?.[1]?.replace(/\n\/\/ /g, " ") ?? "";
    sections.push(
      [
        `## ${name}`,
        ...(header ? ["", header] : []),
        "",
        "| Method | Path | Who | What |",
        "|---|---|---|---|",
        ...routes.map(
          (r) => `| ${r.method} | \`${r.path}\` | ${r.who} | ${r.doc.replace(/\|/g, "\\|") || "–"} |`,
        ),
      ].join("\n"),
    );
  }
  return `${[
    "# API reference",
    "",
    "Generated from the route definitions in `apps/api/src` by `pnpm --filter @brio/api docs:api`; do not edit by hand.",
    "",
    "Every request is made as a signed-in person (the session cookie the web app uses) or with an API token",
    "(`Authorization: Bearer brio_pat_…`, bound to one workspace). Requests act in the workspace named by the",
    "`x-brio-workspace` header, else the session's active one. Bodies and responses are JSON; errors are",
    '`{ "error": code, "message": text }` with the HTTP status. Live events are Server-Sent Events',
    "(`GET /v1/missions/:id/events`, resumable with `Last-Event-ID`). Sign-in and OAuth for MCP clients are Better",
    "Auth's routes under `/api/auth`; Brio's MCP server is at `/mcp` (tools listed in `docs/ARCHITECTURE.md`).",
    "",
    "**Who** lists the workspace roles a route requires (owner, admin, member, viewer); *any member* includes",
    "viewers. Routes marked *signed-in person only* refuse API tokens.",
    "",
    ...sections.flatMap((s) => [s, ""]),
  ]
    .join("\n")
    .trimEnd()}\n`;
}

const here = dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = join(here, "../../../docs/API.md");
  writeFileSync(out, buildApiReference(join(here, "../src")));
  process.stdout.write(`wrote ${out}\n`);
}
