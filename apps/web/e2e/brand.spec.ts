import type { Page } from "@playwright/test";
import { expect, signIn, test, uniqueEmail } from "./fixtures";

// Computed colours as the browser reports them; source values live in packages/brand/tokens.css.
const DARK_BG = "rgb(11, 13, 23)"; // --bg dark  #0B0D17
const LIGHT_BG = "rgb(247, 247, 250)"; // --bg light #F7F7FA
const BRASS = "rgb(242, 179, 61)"; // --brio-brass #F2B33D
const BRASS_DEEP = "rgb(201, 138, 18)"; // --brio-brass-deep #C98A12

const bodyBg = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test.describe("brand", () => {
  test("dark theme is the default", async ({ authed: page }) => {
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await bodyBg(page)).toBe(DARK_BG);
  });

  test("dark stays the default even when the OS prefers light", async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: "light" });
    const page = await context.newPage();
    await page.goto("/sign-in");
    expect(await bodyBg(page)).toBe(DARK_BG);
    await context.close();
  });

  test("light theme toggle switches tokens and persists", async ({ authed: page }) => {
    await page.getByRole("button", { name: "Switch to light theme" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    expect(await bodyBg(page)).toBe(LIGHT_BG);
    await page.reload();
    expect(await bodyBg(page)).toBe(LIGHT_BG);
    await expect(page.getByTestId("brio-cursor")).toHaveCSS("background-color", BRASS_DEEP);
  });

  test("header wordmark is brio_ in Geist Mono with a brass cursor, solid when idle", async ({
    authed: page,
  }) => {
    const home = page.getByRole("link", { name: "Brio home" });
    await expect(home).toContainText("brio");
    const fontFamily = await home
      .locator("span")
      .first()
      .evaluate((el) => getComputedStyle(el).fontFamily);
    expect(fontFamily.toLowerCase()).toMatch(/^"?geist ?mono/);
    const cursor = page.getByTestId("brio-cursor");
    await expect(cursor).toHaveCSS("background-color", BRASS);
    await expect(cursor).toHaveAttribute("data-state", "idle");
    await expect(cursor).toHaveCSS("animation-name", "none");
  });

  test("UI text is set in Geist Sans", async ({ page }) => {
    await page.goto("/sign-in");
    const fontFamily = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    expect(fontFamily.toLowerCase()).toMatch(/^"?geist(?! ?mono)/);
  });

  test("favicon, app icons, manifest and OG image are wired and served", async ({ page, request }) => {
    await page.goto("/sign-in");
    const head = page.locator("head");
    await expect(head.locator('link[rel="icon"][type="image/svg+xml"]')).toHaveAttribute(
      "href",
      "/brand/favicon.svg",
    );
    await expect(head.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", "/brand/icon-180.png");
    await expect(head.locator('meta[property="og:image"]')).toHaveAttribute(
      "content",
      /\/brand\/og-card\.png$/,
    );
    await expect(head.locator('meta[name="twitter:card"]')).toHaveAttribute("content", "summary_large_image");
    for (const path of [
      "/brand/favicon.svg",
      "/brand/icon-180.png",
      "/brand/icon-192.png",
      "/brand/icon-512.png",
      "/brand/og-card.png",
    ]) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(200);
    }
    const manifest = await (await request.get("/manifest.webmanifest")).json();
    expect(manifest.name).toBe("Brio");
    expect(manifest.icons.map((i: { src: string }) => i.src)).toContain("/brand/icon-512.png");
  });

  test("the cursor does not animate with reduced motion", async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    await signIn(page, uniqueEmail("motion"));
    const name = await page
      .locator("pre .brio-cursor")
      .first()
      .evaluate((el) => getComputedStyle(el).animationName);
    expect(name).toBe("none");
    await context.close();
  });
});
