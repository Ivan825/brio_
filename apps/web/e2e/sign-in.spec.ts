// A sign-in link works once. Opened again (a second click, a reload, another window), it comes back to the sign-in
// page with a plain explanation instead of a bare error.
import { expect, lastMail, signIn, test, uniqueEmail } from "./fixtures";

test("a used sign-in link explains itself on the sign-in page", async ({ page, browser }) => {
  const email = uniqueEmail("twice");
  await signIn(page, email);
  const { link } = await lastMail(email);

  const other = await browser.newContext();
  const again = await other.newPage();
  await again.goto(new URL(link).pathname + new URL(link).search);
  await expect(again).toHaveURL(/\/sign-in\?/);
  await expect(again.getByTestId("link-failed")).toContainText("already used or has expired");
  await expect(again.getByRole("button", { name: "Email me a sign-in link" })).toBeVisible();

  // The browser that used it is still signed in, and the same link there just lands in the app.
  await page.goto(new URL(link).pathname + new URL(link).search);
  await expect(page).toHaveURL(/\/missions$/);
  await other.close();
});
