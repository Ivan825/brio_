// Sandbox escape suite (M10 security review, docs/SECURITY_REVIEW.md): what a hostile agent tries from inside its
// sandbox, and that each attempt fails — reaching the host's Docker, gaining privileges or capabilities, touching the
// kernel's interfaces, making namespaces, exhausting the machine, and getting data out other than through its proxy's
// allowlist (private addresses, cloud metadata, the Docker host, DNS). Needs Docker.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseSandbox, type SandboxSpec } from "@brio/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerAvailable } from "../src/docker";
import { DEFAULT_IMAGES, ensureImage } from "../src/images";
import { DockerSandbox } from "../src/sandbox/docker-sandbox";

const hasDocker = await dockerAvailable();

describe.skipIf(!hasDocker)("sandbox escape attempts", () => {
  let dir: string;
  let s: DockerSandbox;
  // Small limits, so exhausting them cannot hurt the machine running the test.
  const spec: SandboxSpec = {
    ...chooseSandbox({
      route: "cli",
      taskType: "code.feature",
      agentSetting: "standard",
      vendorHosts: [],
      maxMinutes: 5,
    })!,
    network: { mode: "allowlist", hosts: ["example.com"] },
    memoryMb: 256,
    pids: 64,
    cpus: 1,
  };
  const sh = async (cmd: string, timeoutMs = 30_000) => {
    const r = await s.exec(cmd, { timeoutMs });
    return { ...r, out: `${r.stdout}${r.stderr}`.trim() };
  };

  beforeAll(async () => {
    await ensureImage(DEFAULT_IMAGES, "base");
    await ensureImage(DEFAULT_IMAGES, "proxy");
    dir = await mkdtemp(join(tmpdir(), "brio-escape-"));
    s = await DockerSandbox.create({
      attemptId: "00000000-0000-7000-8000-0000000000e5",
      runnerId: "escape-test",
      spec,
      image: DEFAULT_IMAGES.base,
      images: DEFAULT_IMAGES,
      worktree: dir,
      scratchDir: join(dir, "..", "scratch-escape"),
    });
  }, 600_000);
  afterAll(async () => {
    await s?.destroy();
    await rm(dir, { recursive: true, force: true });
    await rm(join(dir, "..", "scratch-escape"), { recursive: true, force: true });
  });

  it("cannot reach the host's Docker", async () => {
    expect((await sh("test -e /var/run/docker.sock")).exitCode).not.toBe(0);
    expect((await sh('echo "$DOCKER_HOST"')).out).toBe("");
    // The Docker host's API on the default bridge gateway, through the only way out: refused by the proxy.
    expect(
      (await sh("curl -sS -m 5 -o /dev/null -w '%{http_code}' http://172.17.0.1:2375/version")).out,
    ).toBe("403");
  });

  it("has no privileges to gain: no capabilities, no new privileges, a seccomp filter", async () => {
    const status = (await sh("grep -E '^(CapEff|CapBnd|CapPrm|NoNewPrivs|Seccomp):' /proc/self/status")).out;
    expect(status).toMatch(/CapEff:\s+0{16}/);
    expect(status).toMatch(/CapBnd:\s+0{16}/);
    expect(status).toMatch(/CapPrm:\s+0{16}/);
    expect(status).toMatch(/NoNewPrivs:\s+1/);
    expect(status).toMatch(/Seccomp:\s+2/);
    expect((await sh("id -u")).out).not.toBe("0");
    expect((await sh("command -v sudo")).exitCode).not.toBe(0);
    // A setuid copy of a shell made in the worktree runs as the same user (no-new-privileges).
    expect((await sh("cp /bin/sh /work/suid && chmod u+s /work/suid && /work/suid -c 'id -u'")).out).not.toBe(
      "0",
    );
  });

  it("cannot touch the kernel's interfaces or make namespaces", async () => {
    expect((await sh("mount -t tmpfs none /mnt")).exitCode).not.toBe(0);
    expect((await sh("unshare -Ur id")).exitCode).not.toBe(0);
    expect((await sh("echo 1 > /proc/sys/kernel/panic")).exitCode).not.toBe(0);
    expect((await sh("touch /sys/x")).exitCode).not.toBe(0);
    expect((await sh("hostname evil")).exitCode).not.toBe(0);
    expect((await sh("touch /etc/x /usr/x /bin/x")).exitCode).not.toBe(0);
  });

  it("sees only its own processes", async () => {
    expect((await sh("tr '\\0' ' ' < /proc/1/cmdline")).out).toMatch(/docker-init/);
    expect(Number((await sh("ps -e --no-headers | wc -l")).out)).toBeLessThan(20);
  });

  it("cannot get data out except through its proxy's allowlist", async () => {
    // No resolver for outside names: no DNS channel.
    expect((await sh("getent hosts example.com")).exitCode).not.toBe(0);
    // Straight out, bypassing the proxy: no route.
    expect((await sh("curl -sS -m 5 --noproxy '*' http://93.184.215.14/")).exitCode).not.toBe(0);
    // Through the proxy: private ranges, cloud metadata (also IPv4-mapped IPv6) and hosts not on the list refused.
    for (const url of [
      "http://10.0.0.1/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::ffff:169.254.169.254]/",
      "http://metadata.google.internal/",
      "http://example.org/",
    ])
      expect((await sh(`curl -sS -m 5 -o /dev/null -w '%{http_code}' '${url}'`)).out, url).toBe("403");
    // Nothing secret in its environment.
    expect((await sh("env | grep -iE 'key|token|secret|passw' || true")).out).toBe("");
  });

  it("survives a fork bomb and a memory hog, and stays usable", async () => {
    const bomb = await sh("for i in $(seq 200); do sleep 4 & done; wait", 60_000);
    expect(bomb.exitCode).not.toBe(0);
    expect(bomb.out).toMatch(/fork|Resource temporarily unavailable/i);
    // Once the bomb's processes end, the sandbox works again (a pipeline: several processes at once).
    let alive = "";
    for (let i = 0; i < 30 && alive !== "alive"; i++) {
      alive = (await sh("echo alive | cat | tr -d ' '").catch(() => ({ out: "" }))).out;
      if (alive !== "alive") await new Promise((r) => setTimeout(r, 500));
    }
    expect(alive).toBe("alive");
    const hog = await sh("python3 -c \"b = bytearray(1024 * 1024 * 1024); print('allocated')\"", 60_000);
    expect(hog.out).not.toContain("allocated");
    expect((await sh("echo alive")).out).toBe("alive");
    // A full /tmp is a full /tmp: 1 GB, in memory limits of its own, never the host's disk.
    expect((await sh("df -k /tmp | tail -1 | awk '{print $2}'")).out).toBe("1048576");
  });
});
