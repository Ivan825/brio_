// The public status page: anyone can see whether each part of Brio works, without signing in.
import { expect, test } from "./fixtures";

test("the status page is public and lists each part of Brio", async ({ page }) => {
  await page.goto("/status");
  const board = page.getByTestId("status");
  await expect(board).toBeVisible();
  await expect(board.getByTestId("status-component")).toHaveCount(4);
  for (const name of ["API", "Database", "Live events", "Runners"])
    await expect(board.getByTestId("status-component").filter({ hasText: name })).toBeVisible();
  await expect(board.getByRole("status")).toContainText(/All working|Working, with problems/);
});
