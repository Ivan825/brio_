// The npm package (D-111): one bundled file that runs with nothing installed but Node, the sandbox image sources the
// local runner builds from, and a manifest that names `brio` as its command and depends on nothing.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import own from "../package.json" with { type: "json" };
// @ts-expect-error: a plain ES module script, without types
import { NPM_NAME, pack } from "../scripts/pack.mjs";

describe("the npm package", () => {
  let out: string;
  const brio = (...args: string[]) =>
    execFileSync(process.execPath, [join(out, "dist/brio.mjs"), ...args], {
      encoding: "utf8",
      // Nothing from the workspace: the bundle must stand alone.
      cwd: out,
      env: { PATH: process.env.PATH ?? "", HOME: out },
    });

  beforeAll(async () => {
    out = await mkdtemp(join(tmpdir(), "brio-npm-"));
    await pack(out);
  }, 120_000);
  afterAll(() => rm(out, { recursive: true, force: true }));

  it("is brio-orchestrator, at the CLI's version, with `brio` as its command and no dependencies", async () => {
    const m = JSON.parse(await readFile(join(out, "package.json"), "utf8"));
    expect(m.name).toBe(NPM_NAME);
    expect(m.version).toBe(own.version);
    expect(m.bin).toEqual({ brio: "dist/brio.mjs" });
    expect(m.dependencies).toBeUndefined();
    expect(m.private).toBeUndefined();
    expect(m.license).toBe("AGPL-3.0-only");
    expect(m.files).toEqual(["dist", "images", "README.md", "LICENSE"]);
  });

  it("runs on its own: version, usage, and a clear message when not signed in", () => {
    expect(brio("--version")).toBe(`brio ${own.version}\n`);
    expect(brio("--help")).toContain("brio run");
    let failed: { status: number; stderr: string } | undefined;
    try {
      brio("whoami");
    } catch (e) {
      failed = e as { status: number; stderr: string };
    }
    expect(failed?.status).toBe(2);
    expect(failed?.stderr).toContain("brio login");
  });

  it("ships the sandbox image sources the local runner builds from, and its readme and licence", () => {
    for (const dir of ["sandbox-base", "sandbox-cli", "sandbox-web", "sandbox-browser", "egress-proxy"])
      expect(existsSync(join(out, "images", dir, "Dockerfile")), dir).toBe(true);
    expect(existsSync(join(out, "README.md"))).toBe(true);
    expect(existsSync(join(out, "LICENSE"))).toBe(true);
  });
});
