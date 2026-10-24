// M9 acceptance in the browser: a confidential task is never routed to a connector its data may not reach — blocked
// with the policy's reason until a data-routing policy allows that connector; the ledger records the change and its
// chain verifies; budgets and notification settings are where a person sets them.
import { createWorkspace, expect, signIn, test, uniqueEmail } from "./fixtures";

const FAKE_VENDOR = `http://127.0.0.1:${process.env.FAKE_VENDOR_PORT ?? 4300}/v1`;

test("confidential work stays put until a policy allows its connector; the ledger verifies", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signIn(page, uniqueEmail("govern"));
  await createWorkspace(page, "Governed");
  await page.goto("/connectors");
  const row = page.getByTestId("catalogue-litellm");
  await row.getByRole("button", { name: "Add key" }).click();
  await row.getByLabel(/Base URL/).fill(FAKE_VENDOR);
  await row.getByLabel(/API key/).fill("e2e-proxy-key-0005");
  await row.getByRole("button", { name: "Add LiteLLM proxy" }).click();
  await expect(page.getByTestId("installed-connector").getByText(/healthy/)).toBeVisible();
  await page.goto("/agents");
  await page.getByLabel("Name", { exact: true }).fill("planner");
  await page.getByLabel(/^Model/).fill("fake-model");
  await page.getByRole("button", { name: "Save agent" }).click();
  await expect(page.getByTestId("agent")).toContainText("planner");

  // A confidential task, and only a cloud agent: the policy engine refuses to route it.
  await page.goto("/missions");
  await page.getByLabel("New mission").fill("Confidential report on salaries");
  await page.getByRole("button", { name: "Plan mission" }).click();
  const panel = page.getByTestId("plan-panel");
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await panel.getByRole("button", { name: "Approve plan" }).click();
  const task = page.getByTestId("task");
  await expect(task).toContainText("confidential work goes only to local models", { timeout: 30_000 });
  const board = page.url();

  // A person allows this connector for confidential work.
  await page.goto("/governance");
  const form = page.getByRole("form", { name: "New policy" });
  await form.getByLabel("Policy name").fill("Our LiteLLM proxy may see confidential work");
  await form.getByLabel("Work that is").selectOption("confidential");
  await form.getByLabel(/may go to connectors/).fill("litellm");
  await form.getByRole("button", { name: "Add policy" }).click();
  await expect(page.getByTestId("policy")).toContainText("confidential work → local models, litellm");

  // Now it runs.
  await page.goto(board);
  await page.getByTestId("task").getByRole("button", { name: "Run now" }).click();
  await expect(
    page.getByTestId("event-stream").locator('li[data-type="attempt.finished"]').first(),
  ).toBeVisible({
    timeout: 60_000,
  });

  // The ledger has the policy change, and its chain is whole.
  await page.goto("/governance");
  const ledger = page.getByTestId("ledger");
  await expect(ledger).toContainText("policy.change");
  await ledger.getByRole("button", { name: "Verify the chain" }).click();
  await expect(ledger).toContainText(/chain intact · \d+ entries/);

  // A monthly budget for the workspace.
  const budgets = page.getByTestId("budgets");
  await budgets.getByLabel("Workspace monthly limit (USD)").fill("25");
  await budgets.getByTestId("budget-row").first().getByRole("button", { name: "Save" }).click();
  await expect(budgets.getByTestId("budget-row").first()).toContainText("of $25.00");

  // Notification preferences.
  await page.goto("/settings");
  const settings = page.getByTestId("notification-settings");
  await settings.getByLabel("Missions done or failed").uncheck();
  await expect(settings.getByRole("status")).toHaveText("saved");
  await page.reload();
  await expect(
    page.getByTestId("notification-settings").getByLabel("Missions done or failed"),
  ).not.toBeChecked();

  // Sharing with the global scoreboard is off until an owner or admin turns it on (D-14).
  await page.goto("/scoreboard");
  const sharing = page.getByTestId("score-sharing");
  const share = sharing.getByRole("checkbox", { name: /Add this workspace's outcomes/ });
  await expect(share).not.toBeChecked();
  await share.click();
  await expect(share).toBeChecked();
  await page.reload();
  await expect(
    page.getByTestId("score-sharing").getByRole("checkbox", { name: /Add this workspace's outcomes/ }),
  ).toBeChecked();
});
