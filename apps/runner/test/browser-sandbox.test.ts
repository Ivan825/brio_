// The browser sandbox for computer use, for real: the image starts a virtual display and Chromium, screenshots are
// PNGs, and clicks and typing reach the page (read back from the window title). No network: the page is a data: URL.
// Needs Docker; builds the browser image on first run.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxActuator, sandboxNovaBrowser } from "@brio/adapters";
import { chooseSandbox } from "@brio/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerAvailable } from "../src/docker";
import { DEFAULT_IMAGES, ensureImage } from "../src/images";
import { DockerSandbox } from "../src/sandbox/docker-sandbox";

const hasDocker = await dockerAvailable();

const PAGE = `data:text/html,<title>ready</title><body style="margin:0">
<input id="q" style="position:fixed;left:0;top:0;width:400px;height:60px" oninput="document.title=this.value">
<button style="position:fixed;left:0;top:200px;width:400px;height:200px" onclick="document.title='clicked'">go</button>`;

describe.skipIf(!hasDocker)("browser sandbox", () => {
  let dir: string;
  let sandbox: DockerSandbox;

  beforeAll(async () => {
    await ensureImage(DEFAULT_IMAGES, "browser");
    dir = await mkdtemp(join(tmpdir(), "brio-browser-"));
    const spec = chooseSandbox({
      route: "browser",
      taskType: "browser.task",
      agentSetting: "standard",
      vendorHosts: [],
      maxMinutes: 10,
    });
    if (!spec) throw new Error("no spec");
    sandbox = await DockerSandbox.create({
      attemptId: "0192b3c4-5d6e-7f80-9a1b-2c3d4e5f6a7c",
      runnerId: "test-runner",
      spec,
      image: DEFAULT_IMAGES.browser,
      images: DEFAULT_IMAGES,
      worktree: dir,
      scratchDir: join(dir, "..", "scratch-browser"),
    });
  }, 30 * 60_000);

  afterAll(async () => {
    await sandbox?.destroy();
    await rm(dir, { recursive: true, force: true });
    await rm(join(dir, "..", "scratch-browser"), { recursive: true, force: true });
  });

  const title = async () =>
    (
      await sandbox.exec(
        "DISPLAY=:99 xdotool search --onlyvisible --class chromium getwindowname %@ 2>/dev/null",
      )
    ).stdout;

  /** The page reacts a moment after the input: wait for the title to show it. */
  const titleMatches = async (re: RegExp) => {
    for (let i = 0; i < 30; i++) {
      if (re.test(await title())) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };

  it("opens the page, sees it, and its clicks and typing reach it", async () => {
    const a = sandboxActuator(sandbox);
    await a.open(PAGE, { width: 1024, height: 768 });
    const shot = await a.screenshot();
    expect([...shot.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const zoom = await a.screenshot([0, 0, 200, 100]);
    expect(zoom.length).toBeGreaterThan(0);
    expect(zoom.length).toBeLessThan(shot.length);

    // Chromium's own UI sits above the page: find the button by clicking down the left edge until the title changes.
    let hit = 0;
    for (let y = 250; y < 700 && !hit; y += 50) {
      await a.act("left_click", { coordinate: [200, y] });
      if (await titleMatches(/clicked/)) hit = y;
    }
    expect(hit).toBeGreaterThan(0);
    // The button's top is 200 px below the input's: the same offset finds the input.
    await a.act("left_click", { coordinate: [200, hit - 200] });
    await a.act("type", { text: "hi there" });
    expect(await titleMatches(/^hi there/)).toBe(true);
    await a.act("key", { text: "ctrl+a" });
    await a.act("key", { text: "BackSpace" });
    await a.act("type", { text: "ok" });
    expect(await titleMatches(/^ok/)).toBe(true);
    expect(await a.act("cursor_position", {})).toMatch(/^X=\d+, Y=\d+$/);
    await a.close();
  }, 120_000);

  it("serves Nova Act: the screen is the viewport, observations are JPEGs, actions land in page coordinates", async () => {
    const b = sandboxNovaBrowser(sandbox);
    await b.open(PAGE);
    const obs = JSON.parse(await b.observe()) as {
      activeURL: string;
      screenshotBase64: string;
      browserDimensions: { windowWidth: number; windowHeight: number };
    };
    expect(obs.activeURL).toMatch(/^data:text\/html,/);
    expect(obs.screenshotBase64).toMatch(/^data:image\/jpeg;base64,\/9j\//);
    // Within a pixel of Nova Act's 1600×813 (the SDK accepts ±20%).
    expect(Math.abs(obs.browserDimensions.windowWidth - 1600)).toBeLessThanOrEqual(2);
    expect(Math.abs(obs.browserDimensions.windowHeight - 813)).toBeLessThanOrEqual(2);
    // Page coordinates: the button is at 200–400 px down the page, the input at the top.
    await b.click(200, 300, "left");
    expect(await titleMatches(/clicked/)).toBe(true);
    await b.type(200, 30, "nova here", false);
    expect(await titleMatches(/^nova here/)).toBe(true);
    await b.close();
  }, 120_000);
});
