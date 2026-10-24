import { expect, test } from "./fixtures";

const SCREENS = [
  { path: "/missions", nav: "Missions", heading: "Create a workspace first" },
  { path: "/inbox", nav: "Inbox", heading: "Nothing is waiting for you" },
  { path: "/projects", nav: "Projects", heading: "Create a workspace first" },
  { path: "/connectors", nav: "Connectors", heading: "Connectors" },
  { path: "/agents", nav: "Agents", heading: "Agents" },
  { path: "/crews", nav: "Crews", heading: "Create a workspace first" },
  { path: "/templates", nav: "Templates", heading: "Create a workspace first" },
  { path: "/scoreboard", nav: "Scoreboard", heading: "Nothing to score yet" },
  { path: "/evals", nav: "Evals", heading: "No eval runs yet" },
  { path: "/governance", nav: "Governance", heading: "Create a workspace first" },
  { path: "/settings", nav: "Settings", heading: "Workspace settings" },
];

test("signed-out visitors are sent to sign-in", async ({ page }) => {
  await page.goto("/missions");
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page).toHaveTitle("Sign in · Brio");
});

test("root redirects to missions", async ({ authed: page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/missions$/);
});

for (const { path, nav, heading } of SCREENS) {
  test(`${nav} opens and is reachable from the nav`, async ({ authed: page }) => {
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

test("no horizontal scroll at phone width", async ({ authed: page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/missions");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
