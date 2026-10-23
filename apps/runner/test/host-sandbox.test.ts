// The local runner's restricted mode: processes run in the worktree (seen as /work), with a cut-down environment, and
// stop together when killed. Paths outside the worktree are refused.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { HostSandbox } from "../src/sandbox/host-sandbox";

describe("HostSandbox", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });
  const make = async () => {
    const root = await mkdtemp(join(tmpdir(), "brio-host-"));
    dirs.push(root);
    return new HostSandbox(root, "attempt-1", {
      PATH: process.env.PATH,
      HOME: "/home/someone",
      SECRET_TOKEN: "s3cret",
    });
  };

  it("works inside the worktree only", async () => {
    const s = await make();
    await s.writeFile("src/a.txt", "hello");
    await s.writeFile("/work/src/b.txt", "world");
    expect(await readFile(join(s.root, "src/a.txt"), "utf8")).toBe("hello");
    expect(await s.readFile("/work/src/b.txt")).toBe("world");
    expect((await s.listFiles(".")).sort()).toEqual(["src/a.txt", "src/b.txt"]);
    await expect(s.writeFile("../escape.txt", "x")).rejects.toThrow(/outside/);
    await expect(s.readFile("/etc/passwd")).rejects.toThrow(/outside/);
    const r = await s.exec("pwd && cat src/a.txt");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("hello");
    expect(r.stdout.split("\n")[0]).toMatch(/brio-host-/);
  });

  it("passes a CLI only what it needs from the environment, and /work as the worktree", async () => {
    const s = await make();
    const p = s.spawn(
      ["sh", "-c", 'echo "home=$HOME secret=${SECRET_TOKEN:-none} key=$KEY"; ls "$1"', "sh", "/work"],
      {
        env: { KEY: "given" },
      },
    );
    await s.writeFile("x.txt", "1");
    const out: string[] = [];
    for await (const line of p.lines) out.push(line);
    expect((await p.exit).code).toBe(0);
    expect(out[0]).toBe("home=/home/someone secret=none key=given");
  });

  it("stops everything it started when killed", async () => {
    const s = await make();
    const p = s.spawn(["sh", "-c", "sleep 30 & sleep 30"], { env: {} });
    const started = Date.now();
    setTimeout(() => void s.kill(), 200);
    await p.exit;
    expect(Date.now() - started).toBeLessThan(5000);
    expect((await s.exec("echo late")).stderr).toBe("stopped");
  });
});
