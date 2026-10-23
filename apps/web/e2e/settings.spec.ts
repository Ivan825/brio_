import { createWorkspace, expect, signIn, test, uniqueEmail } from "./fixtures";

test("make an API token for MCP clients: shown once, listed by prefix, revoked", async ({ page }) => {
  await signIn(page, uniqueEmail("tokens"));
  await createWorkspace(page, "Tokens");
  await page.goto("/settings");
  await page.getByLabel("Token name").fill("claude code");
  await page.getByRole("button", { name: "Create token" }).click();
  const fresh = page.getByTestId("new-token");
  await expect(fresh).toContainText(/brio_pat_[0-9A-Za-z]{40}/);
  await expect(fresh).toContainText("claude mcp add --transport http brio");
  const token = (await fresh.locator("code").textContent()) ?? "";
  const row = page.getByTestId("api-token");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("claude code");
  await expect(row).toContainText(`${token.slice(0, 13)}…`);
  await expect(row).toContainText("never used");
  await row.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByTestId("api-token")).toHaveCount(0);
});
