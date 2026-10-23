// M8 (PRD F3): the plan editor — every edit is a new, linted plan version; list and graph views.
import { createWorkspace, expect, signIn, test, uniqueEmail } from "./fixtures";

const FAKE_VENDOR = `http://127.0.0.1:${process.env.FAKE_VENDOR_PORT ?? 4300}/v1`;

test("edit a proposed plan: words, a new task, order, the graph, a split, a merge and a gate", async ({
  page,
}) => {
  await signIn(page, uniqueEmail("planner"));
  await createWorkspace(page, "Plans");
  await page.goto("/connectors");
  const row = page.getByTestId("catalogue-litellm");
  await row.getByRole("button", { name: "Add key" }).click();
  await row.getByLabel(/Base URL/).fill(FAKE_VENDOR);
  await row.getByLabel(/API key/).fill("e2e-proxy-key-0003");
  await row.getByRole("button", { name: "Add LiteLLM proxy" }).click();
  await expect(page.getByTestId("installed-connector").getByText(/healthy/)).toBeVisible();
  await page.goto("/agents");
  await page.getByLabel("Name", { exact: true }).fill("planner");
  await page.getByLabel(/^Model/).fill("fake-model");
  await page.getByRole("button", { name: "Save agent" }).click();
  await expect(page.getByTestId("agent")).toContainText("planner");

  await page.goto("/missions");
  await page.getByLabel("New mission").fill("Add a health endpoint");
  await page.getByRole("button", { name: "Plan mission" }).click();
  const panel = page.getByTestId("plan-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel).toHaveAttribute("data-version", "1");
  const task = (key: string) => panel.locator(`[data-testid="planned-task"][data-key="${key}"]`);

  // Words.
  await task("write.health-plan").getByRole("button", { name: "Edit" }).click();
  await task("write.health-plan").getByLabel("Title").fill("Plan the health endpoint");
  await task("write.health-plan").getByRole("button", { name: "Save changes" }).click();
  await expect(panel).toHaveAttribute("data-version", "2");
  await expect(task("write.health-plan")).toContainText("Plan the health endpoint");

  // A new task, then moved first.
  await panel.getByRole("button", { name: "Add a task" }).click();
  await panel.getByLabel("New task").fill("Check the docs");
  await panel.getByLabel("What it must achieve").fill("List what the docs say about health checks");
  await panel.getByRole("button", { name: "Add", exact: true }).click();
  await expect(panel).toHaveAttribute("data-version", "3");
  await expect(panel.getByTestId("planned-task")).toHaveCount(2);
  await panel.getByRole("button", { name: "Move check-the-docs up" }).click();
  await expect(panel).toHaveAttribute("data-version", "4");
  await expect(panel.getByTestId("planned-task").first()).toHaveAttribute("data-key", "check-the-docs");

  // The graph view, then a dependency set from the editor.
  await panel.getByRole("button", { name: "Graph" }).click();
  await expect(panel.getByTestId("graph-node")).toHaveCount(2);
  await panel.locator('[data-testid="graph-node"][data-key="write.health-plan"]').click();
  // Controlled by the saved plan: it shows checked once the new version is back.
  await task("write.health-plan").getByLabel("check-the-docs").click();
  await expect(panel).toHaveAttribute("data-version", "5");
  await panel.getByRole("button", { name: "List" }).click();
  await expect(task("write.health-plan")).toContainText("after check-the-docs");

  // Split, then merge the parts back.
  await task("check-the-docs").getByRole("button", { name: "Edit" }).click();
  await task("check-the-docs").getByLabel("First part").fill("Read the docs");
  await task("check-the-docs").getByLabel("Second part").fill("Summarise them");
  await task("check-the-docs").getByRole("button", { name: "Split" }).click();
  await expect(panel).toHaveAttribute("data-version", "6");
  await expect(panel.getByTestId("planned-task")).toHaveCount(3);
  await panel.getByLabel("Select check-the-docs-1 to merge").check();
  await panel.getByLabel("Select check-the-docs-2 to merge").check();
  await panel.getByRole("button", { name: "Merge 2 selected tasks" }).click();
  await expect(panel).toHaveAttribute("data-version", "7");
  await expect(panel.getByTestId("planned-task")).toHaveCount(2);

  // An approval gate on the new task, then approve.
  await task("check-the-docs-1").getByRole("button", { name: "Edit" }).click();
  await task("check-the-docs-1").getByLabel("A person approves the result").click();
  await expect(panel).toHaveAttribute("data-version", "8");
  await expect(task("check-the-docs-1")).toContainText("approval gate");
  await panel.getByRole("button", { name: "Approve plan" }).click();
  await expect(page.getByTestId("event-stream").locator('li[data-type="plan.approved"]')).toHaveCount(1);
});
