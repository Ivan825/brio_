// Chat (D-109) in the browser: ask, get the reply live, see who answered, copy it, and hand it to a mission.
import { createWorkspace, expect, signIn, test, uniqueEmail } from "./fixtures";

const FAKE_VENDOR = `http://127.0.0.1:${process.env.FAKE_VENDOR_PORT ?? 4300}/v1`;

test("chat with an agent: the reply arrives live, and the chat can become a mission", async ({ page }) => {
  await signIn(page, uniqueEmail("chat"));
  await createWorkspace(page, "Chatroom");

  // No agents yet: the chat says what to do.
  await page.goto("/chat");
  await expect(page.getByRole("link", { name: "Add a connector" })).toBeVisible();

  await page.goto("/connectors");
  const row = page.getByTestId("catalogue-litellm");
  await row.getByRole("button", { name: "Add key" }).click();
  await row.getByLabel(/Base URL/).fill(FAKE_VENDOR);
  await row.getByLabel(/API key/).fill("e2e-proxy-key-0002");
  await row.getByRole("button", { name: "Add LiteLLM proxy" }).click();
  await expect(page.getByTestId("installed-connector").getByText(/healthy/)).toBeVisible();
  await page.goto("/agents");
  await page.getByLabel("Name", { exact: true }).fill("helper");
  await page.getByLabel(/^Model/).fill("fake-model");
  await page.getByRole("button", { name: "Save agent" }).click();
  await expect(page.getByTestId("agent")).toContainText("helper");

  await page.getByRole("link", { name: "Chat" }).first().click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByRole("heading", { name: "What should your agents work on?" })).toBeVisible();
  // One agent: the multi-agent modes say they need two.
  await expect(page.getByRole("button", { name: "Together" })).toBeDisabled();

  const box = page.getByRole("textbox", { name: "Message" });
  await box.fill("How do I add a health endpoint?");
  await box.press("Enter");
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
  const turn = page.getByTestId("chat-turn").first();
  await expect(turn).toHaveAttribute("data-status", "done", { timeout: 30_000 });
  await expect(turn.getByTestId("chat-answer")).toContainText("add GET /health");
  await expect(turn).toContainText("helper");
  await expect(page.getByRole("link", { name: "How do I add a health endpoint?" })).toBeVisible();

  // A follow-up in the same chat.
  await box.fill("And a test for it?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("chat-turn")).toHaveCount(2);
  await expect(page.getByTestId("chat-turn").nth(1)).toHaveAttribute("data-status", "done", {
    timeout: 30_000,
  });

  // Chats are not missions…
  await page.goto("/missions");
  await expect(page.getByText("How do I add a health endpoint?")).toHaveCount(0);
  // …until one is handed over.
  await page.goBack();
  await page.getByTestId("chat-turn").nth(1).getByRole("button", { name: "Turn into a mission" }).click();
  await expect(page).toHaveURL(/\/missions\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "And a test for it?" })).toBeVisible();
});
