import { randomBytes } from "node:crypto";
import { test as base, expect, type Page } from "@playwright/test";
import { API_PORT } from "../playwright.config";

export const uniqueEmail = (name: string) => `${name}-${randomBytes(4).toString("hex")}@example.com`;

/** Latest email the API "sent" to this address (local outbox; BRIO_DEV_OUTBOX=true). */
export async function lastMail(email: string): Promise<{ subject: string; link: string }> {
  let messages: { subject: string; link: string }[] = [];
  for (let i = 0; i < 20 && messages.length === 0; i++) {
    const res = await fetch(`http://127.0.0.1:${API_PORT}/v1/dev/outbox?email=${encodeURIComponent(email)}`);
    messages = (await res.json()).messages;
    if (!messages.length) await new Promise((r) => setTimeout(r, 100));
  }
  const m = messages.at(-1);
  if (!m) throw new Error(`no email for ${email}`);
  return m;
}

/** Signs in through the real UI: request a magic link, then open the emailed link. */
export async function signIn(page: Page, email: string, next?: string) {
  await page.goto(next ? `/sign-in?next=${encodeURIComponent(next)}` : "/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  const { link } = await lastMail(email);
  await page.goto(new URL(link).pathname + new URL(link).search);
  await expect(page).toHaveURL(new RegExp(`${next ?? "/missions"}$`));
}

export async function createWorkspace(page: Page, name: string) {
  await page.getByTestId("workspace-switcher").click();
  await page.getByRole("menuitem", { name: "New workspace" }).click();
  await page.getByLabel("Workspace name").fill(name);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByTestId("workspace-switcher")).toHaveText(name);
}

export const test = base.extend<{ authed: Page }>({
  authed: async ({ page }, use) => {
    await signIn(page, uniqueEmail("user"));
    await use(page);
  },
});
export { expect };
