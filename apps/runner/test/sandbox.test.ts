// Docker sandbox: isolation, limits, egress allowlist, file confinement, processes and kill. Needs Docker.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseSandbox, type SandboxSpec } from "@brio/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { docker, dockerAvailable } from "../src/docker";
import { DEFAULT_IMAGES, ensureImage } from "../src/images";
import { confine, DockerSandbox } from "../src/sandbox/docker-sandbox";

const hasDocker = await dockerAvailable();
const offline = process.env.BRIO_TEST_OFFLINE === "1";

const spec = (over: Partial<SandboxSpec> = {}): SandboxSpec => ({
  ...chooseSandbox({
    route: "cli",
    taskType: "code.feature",
    agentSetting: "standard",
    vendorHosts: [],
    maxMinutes: 5,
  })!,
  network: { mode: "none" },
  ...over,
});

describe("confine", () => {
  it("keeps paths inside /work", () => {
    expect(confine("src/a.ts")).toBe("/work/src/a.ts");
    expect(confine("./a/../b")).toBe("/work/b");
    expect(confine(".")).toBe("/work");
    for (const bad of ["/etc/passwd", "../x", "a/../../x", ""]) expect(() => confine(bad)).toThrow();
  });
});

describe.skipIf(!hasDocker)("docker sandbox", () => {
  let dir: string;
  const made: DockerSandbox[] = [];
  const create = async (s: SandboxSpec, id: string) => {
    const sbx = await DockerSandbox.create({
      attemptId: id,
      runnerId: "test-runner",
      spec: s,
      image: DEFAULT_IMAGES.base,
      images: DEFAULT_IMAGES,
      worktree: dir,
      scratchDir: join(dir, "..", "scratch"),
    });
    made.push(sbx);
    return sbx;
  };

  beforeAll(async () => {
    await ensureImage(DEFAULT_IMAGES, "base");
    await ensureImage(DEFAULT_IMAGES, "proxy");
    dir = await mkdtemp(join(tmpdir(), "brio-sbx-"));
  });
  afterAll(async () => {
    await Promise.all(made.map((s) => s.destroy()));
    await rm(dir, { recursive: true, force: true });
    await rm(join(dir, "..", "scratch"), { recursive: true, force: true });
  });

  it("runs non-root with a read-only root, no capabilities and the profile's limits", async () => {
    const s = await create(spec(), "00000000-0000-7000-8000-000000000001");
    expect((await s.exec("id -u")).stdout.trim()).not.toBe("0");
    expect((await s.exec("touch /usr/local/x")).exitCode).not.toBe(0);
    expect((await s.exec("touch /tmp/ok && echo ok")).stdout.trim()).toBe("ok");
    const info = JSON.parse((await docker(["inspect", s.name])).stdout)[0].HostConfig;
    expect(info).toMatchObject({
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      PidsLimit: 512,
      Memory: 4096 * 1024 * 1024,
    });
    expect(info.SecurityOpt).toContain("no-new-privileges");
    expect(info.Binds.join(" ")).not.toContain("docker.sock");
  });

  it("reads and writes only inside the worktree, and the host sees the files", async () => {
    const s = await create(spec(), "00000000-0000-7000-8000-000000000002");
    await s.writeFile("src/hello.txt", "hi from the sandbox\n");
    expect(await s.readFile("src/hello.txt")).toBe("hi from the sandbox\n");
    expect(await readFile(join(dir, "src", "hello.txt"), "utf8")).toBe("hi from the sandbox\n");
    expect(await s.listFiles(".")).toContain("src/hello.txt");
    await expect(s.readFile("../../etc/passwd")).rejects.toThrow(/outside/);
  });

  it("starts even where a runner that died left a container under the attempt's name", async () => {
    const id = "00000000-0000-7000-8000-00000000000a";
    await docker([
      "run",
      "-d",
      "--name",
      `brio-sbx-${id.replaceAll("-", "").slice(-12)}`,
      DEFAULT_IMAGES.base,
      "sleep",
      "300",
    ]);
    const s = await create(spec(), id);
    expect((await s.exec("echo up")).stdout.trim()).toBe("up");
  });

  it("has no network at all in mode none", async () => {
    const s = await create(spec(), "00000000-0000-7000-8000-000000000003");
    const r = await s.exec("curl -sS -m 5 https://example.com", { timeoutMs: 20_000 });
    expect(r.exitCode).not.toBe(0);
  });

  it.skipIf(offline)(
    "reaches allow-listed hosts only through its proxy; everything else is refused",
    async () => {
      const s = await create(
        spec({ network: { mode: "allowlist", hosts: ["example.com"] } }),
        "00000000-0000-7000-8000-000000000004",
      );
      const ok = await s.exec("curl -sS -m 20 -o /dev/null -w '%{http_code}' https://example.com", {
        timeoutMs: 40_000,
      });
      expect(ok.stdout.trim(), ok.stderr).toBe("200");
      const denied = await s.exec("curl -sS -m 20 -o /dev/null -w '%{http_code}' https://example.org", {
        timeoutMs: 40_000,
      });
      expect(denied.exitCode).not.toBe(0);
      expect(denied.stderr).toMatch(/403/);
      const direct = await s.exec("curl -sS -m 5 --noproxy '*' https://example.com", { timeoutMs: 20_000 });
      expect(direct.exitCode).not.toBe(0);
      const metadata = await s.exec(
        "curl -sS -m 5 -o /dev/null -w '%{http_code}' http://169.254.169.254/latest/meta-data/",
        { timeoutMs: 20_000 },
      );
      expect(metadata.stdout.trim(), metadata.stderr).toBe("403");
    },
  );

  it("streams a process's output with secrets only in its environment, and kills it within 10 s", async () => {
    const s = await create(spec(), "00000000-0000-7000-8000-000000000005");
    const p = s.spawn(
      ["sh", "-c", 'echo "{\\"k\\":\\"$BRIO_TEST_KEY\\"}"; read line; echo "$line"; sleep 300'],
      {
        env: { BRIO_TEST_KEY: "value-from-env" },
        stdin: "from-stdin\n",
      },
    );
    const seen: string[] = [];
    const reader = (async () => {
      for await (const l of p.lines) seen.push(l);
    })();
    await new Promise((r) => setTimeout(r, 1500));
    expect(seen).toEqual(['{"k":"value-from-env"}', "from-stdin"]);
    const started = Date.now();
    await p.kill();
    await p.exit;
    await reader;
    expect(Date.now() - started).toBeLessThan(10_000);
    const state = JSON.parse((await docker(["inspect", s.name])).stdout)[0].State;
    expect(state.Running).toBe(false);
  });
});
