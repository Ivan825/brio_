import { expect, test } from "@playwright/test";

const SCREENS = [
  { path: "/missions", nav: "Missions", heading: "No missions yet" },
  { path: "/connectors", nav: "Connectors", heading: "No connectors yet" },
  { path: "/agents", nav: "Agents", heading: "No agents yet" },
  { path: "/scoreboard", nav: "Scoreboard", heading: "Nothing to score yet" },
  { path: "/settings", nav: "Settings", heading: "Workspace settings" },
];

test("root redirects to missions", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/missions$/);
});

for (const { path, nav, heading } of SCREENS) {
  test(`${nav} shows its empty state and is reachable from the nav`, async ({ page }) => {
    await page.goto("/missions");
    await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: nav }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(page.getByTestId("breadcrumb")).toHaveText(`~${path}`);
    await expect(page.getByRole("link", { name: nav, exact: true }).first()).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page).toHaveTitle(`${nav} · Brio`);
  });
}

test("unknown paths get the branded 404", async ({ page }) => {
  const res = await page.goto("/nope");
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Nothing at this path" })).toBeVisible();
});

test("no horizontal scroll at phone width", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 800 } });
  const page = await context.newPage();
  await page.goto("/missions");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await context.close();
});
