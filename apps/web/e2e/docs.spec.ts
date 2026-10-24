// The documentation site: public (no sign-in), every page rendered from the repository's docs, links between pages
// working, and the generated API reference listing the routes.
import { expect, test } from "./fixtures";

test("the docs are public, link to each other, and carry the API reference", async ({ page }) => {
  await page.goto("/docs");
  await expect(page.getByRole("heading", { name: "Brio", level: 1 })).toBeVisible();
  await page
    .getByTestId("docs-index")
    .getByRole("link", { name: /Getting started/ })
    .click();
  const doc = page.getByTestId("doc");
  await expect(doc.getByRole("heading", { name: "Getting started", level: 1 })).toBeVisible();
  // A link between documents goes to its page here.
  await doc.getByRole("link", { name: "Self-hosting" }).first().click();
  await expect(page).toHaveURL(/\/docs\/self-host$/);
  await expect(page.getByTestId("doc").getByRole("heading", { name: /Docker Compose/ })).toBeVisible();
  // The API reference, generated from the routes.
  await page.goto("/docs/api");
  await expect(
    page.getByTestId("doc").getByRole("cell", { name: "/v1/missions", exact: true }).first(),
  ).toBeVisible();
  // Every page in the index renders.
  await page.goto("/docs");
  const hrefs = await page
    .getByTestId("docs-index")
    .getByRole("link")
    .evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")));
  expect(hrefs.length).toBeGreaterThanOrEqual(10);
  for (const href of hrefs) {
    const res = await page.goto(href!);
    expect(res?.status(), href!).toBe(200);
    await expect(page.getByTestId("doc").locator("h1").first()).toBeVisible();
  }
});
