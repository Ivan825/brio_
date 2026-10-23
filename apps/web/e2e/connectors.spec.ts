import { createWorkspace, expect, signIn, test, uniqueEmail } from "./fixtures";

const FAKE_VENDOR = `http://127.0.0.1:${process.env.FAKE_VENDOR_PORT ?? 4300}/v1`;

test("the catalogue groups all 98 connectors and marks Meta region-limited", async ({ page }) => {
  await signIn(page, uniqueEmail("catalogue"));
  await createWorkspace(page, "Catalogue");
  await page.getByRole("link", { name: "Connectors" }).first().click();
  await expect(
    page.getByRole("heading", { name: /Catalogue · 98 connectors · 13 categories/ }),
  ).toBeVisible();
  await expect(page.locator('[data-testid^="category-"]')).toHaveCount(13);
  const meta = page.getByTestId("catalogue-meta-model-api-muse-spark");
  await expect(meta.getByText("Preview · region-limited")).toBeVisible();
  await expect(page.getByTestId("catalogue-midjourney").getByText(/not supported/)).toBeVisible();
  await page.getByLabel("available now").check();
  await expect(page.getByTestId("catalogue-a2a-protocol")).toHaveCount(0);
  await expect(page.getByTestId("catalogue-jules")).toBeVisible();
  await expect(page.getByTestId("catalogue-runway")).toBeVisible();
  await expect(page.getByTestId("catalogue-claude-code")).toBeVisible();
  await expect(page.getByTestId("catalogue-openai-api")).toBeVisible();
});

test("add a key, list models live, build an agent and run a task with metered cost", async ({ page }) => {
  await signIn(page, uniqueEmail("operator"));
  await createWorkspace(page, "Metered");

  await page.goto("/connectors");
  const row = page.getByTestId("catalogue-litellm");
  await row.getByRole("button", { name: "Add key" }).click();
  await row.getByLabel(/Base URL/).fill(FAKE_VENDOR);
  await row.getByLabel(/API key/).fill("e2e-proxy-key-0001");
  await row.getByRole("button", { name: "Add LiteLLM proxy" }).click();
  const installed = page.getByTestId("installed-connector");
  await expect(installed).toHaveCount(1);
  await expect(installed.getByText(/healthy/)).toBeVisible();
  await installed.getByRole("button", { name: "Models" }).click();
  await installed.getByRole("button", { name: "List models" }).click();
  await expect(installed.getByTestId("model-list").getByText("fake-model")).toBeVisible();

  await page.goto("/agents");
  await page.getByLabel("Name", { exact: true }).fill("planner");
  await page.getByLabel(/^Model/).fill("fake-model");
  await page.getByLabel("Role prompt").fill("You plan small changes.");
  await page.getByRole("button", { name: "Save agent" }).click();
  await expect(page.getByTestId("agent")).toContainText("planner");

  await page.goto("/missions");
  await page.getByLabel("New mission").fill("Add a health endpoint");
  await page.getByRole("button", { name: "Plan mission" }).click();
  await expect(page).toHaveURL(/\/missions\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("connection")).toHaveAttribute("data-state", "live");

  // The planner (the only agent) proposes a one-task plan; a person approves it and the scheduler runs the task.
  const plan = page.getByTestId("plan-panel");
  await expect(plan).toBeVisible({ timeout: 30_000 });
  await expect(plan.getByTestId("planned-task")).toHaveCount(1);
  await plan.getByRole("button", { name: "Approve plan" }).click();

  const stream = page.getByTestId("event-stream");
  await expect(stream.locator('li[data-type="plan.approved"]')).toHaveCount(1);
  await expect(stream.locator('li[data-type="attempt.finished"]')).toHaveCount(2, { timeout: 30_000 });
  await expect(stream.locator('li[data-type="attempt.cost"]').first()).toContainText("$0.0042");
  const task = page.getByTestId("task");
  await expect(task).toHaveAttribute("data-key", "write.health-plan");
  // One agent: the router runs it alone and says why.
  await expect(stream.locator('li[data-type="task.routed"]')).toHaveCount(1);
  await expect(task.getByTestId("rationale")).toContainText("planner chosen: no history on");
  const attempt = task.getByTestId("attempt");
  await expect(attempt).toHaveAttribute("data-status", "succeeded");
  await expect(attempt.getByTestId("attempt-cost")).toHaveText("$0.0042");
  await attempt.getByRole("button", { name: "Show answer" }).click();
  await expect(page.getByTestId("attempt-output")).toContainText("GET /health");

  // The task's acceptance check is a person: accept it and the mission is done.
  await task.getByTestId("review").getByRole("button", { name: "Accept" }).click();
  await expect(stream.locator('li[data-type="mission.done"]')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId("task")).toHaveAttribute("data-status", "done");

  // The verdict reached the scoreboard; a thumbs up adds to it.
  await page.getByTestId("attempt").getByRole("button", { name: "Rate up" }).click();
  await expect(page.getByTestId("rated")).toHaveText("rated up");
  await page.goto("/scoreboard");
  await expect(page.getByTestId("score-row")).toHaveCount(1);
  await expect(page.getByTestId("score-row")).toContainText("planner");
});
