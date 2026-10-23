import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspace, expect, signIn, test, uniqueEmail } from "./fixtures";

const TOKEN = ["github", "pat", "11E2E0123456789abcdefghijklmnopqrstu"].join("_");

test("add a project with a git token: sealed, shown only as set, replaced and removed", async ({ page }) => {
  await signIn(page, uniqueEmail("projects"));
  await createWorkspace(page, "Projects");
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Projects" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();

  const form = page.getByRole("form", { name: "New project" });
  await form.getByLabel("Name", { exact: true }).fill("site");
  await form.getByLabel("Default branch").fill("main");
  await form.getByLabel("Repository", { exact: true }).fill(join(tmpdir(), "brio-e2e-site.git"));
  await form.getByLabel("Git token (optional)").fill(TOKEN);
  await form.getByLabel("GitHub repository for pull requests").fill("acme/site");
  await form.getByRole("button", { name: "Add project" }).click();

  const row = page.getByTestId("project");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("site");
  await expect(row).toContainText("token set");
  await expect(row).toContainText("PRs → acme/site");
  expect(await page.content()).not.toContain(TOKEN);

  await row.getByRole("button", { name: "Remove token" }).click();
  await expect(row).toContainText("no token");
  await row.getByLabel("New git token for site").fill(TOKEN);
  await row.getByRole("button", { name: "Save token" }).click();
  await expect(row).toContainText("token set");
  expect(await page.content()).not.toContain(TOKEN);
});
