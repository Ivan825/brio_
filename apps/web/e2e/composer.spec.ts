// M8: the mission composer with what a mission starts from and how it is staffed — a crew, attached files — then the
// plan saved as a template and a second mission started from it as is.
import { createWorkspace, expect, signIn, test, uniqueEmail } from "./fixtures";

const FAKE_VENDOR = `http://127.0.0.1:${process.env.FAKE_VENDOR_PORT ?? 4300}/v1`;

test("compose a crew's mission with a file, save its plan as a template, start another from it", async ({
  page,
}) => {
  await signIn(page, uniqueEmail("composer"));
  await createWorkspace(page, "Composer");

  await page.goto("/connectors");
  const row = page.getByTestId("catalogue-litellm");
  await row.getByRole("button", { name: "Add key" }).click();
  await row.getByLabel(/Base URL/).fill(FAKE_VENDOR);
  await row.getByLabel(/API key/).fill("e2e-proxy-key-0002");
  await row.getByRole("button", { name: "Add LiteLLM proxy" }).click();
  await expect(page.getByTestId("installed-connector").getByText(/healthy/)).toBeVisible();
  await page.goto("/agents");
  await page.getByLabel("Name", { exact: true }).fill("planner");
  await page.getByLabel(/^Model/).fill("fake-model");
  await page.getByRole("button", { name: "Save agent" }).click();
  await expect(page.getByTestId("agent")).toContainText("planner");

  // A crew of one, taking summaries.
  await page.goto("/crews");
  const form = page.getByRole("form", { name: "New crew" });
  await form.getByLabel("Crew name").fill("Solo");
  await form.getByLabel(/planner/).check();
  await form.getByLabel("Task type", { exact: true }).selectOption("write.summary");
  await form.getByLabel("Agent for the task type").selectOption({ label: "planner" });
  await form.getByRole("button", { name: "Set" }).click();
  await form.getByRole("button", { name: "Add crew" }).click();
  await expect(page.getByTestId("crew")).toContainText("write.summary → planner");

  await page.goto("/missions");
  await page.getByLabel("New mission").fill("Add a health endpoint");
  await page.getByRole("button", { name: /more options/ }).click();
  await page.getByLabel("Who works on it").selectOption({ label: "Crew: Solo" });
  await page.getByLabel("Files").setInputFiles({
    name: "notes.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Notes\nReturn {ok:true}.\n"),
  });
  await expect(page.getByText("notes.md")).toBeVisible();
  await page.getByRole("button", { name: "Plan mission" }).click();
  await expect(page).toHaveURL(/\/missions\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("mission-inputs")).toContainText("notes.md");
  await expect(page.getByTestId("plan-panel")).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Save as template" }).click();
  await page.getByLabel("Template name").fill("Health plan");
  await page.getByRole("form", { name: "Save as template" }).getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("link", { name: "saved as a template" })).toBeVisible();

  await page.goto("/templates");
  await expect(page.getByTestId("template")).toContainText("Health plan");
  await expect(page.getByTestId("template")).toContainText("Write the health endpoint plan");

  await page.goto("/missions");
  await page.getByLabel("New mission").fill("The same again");
  await page.getByRole("button", { name: /more options/ }).click();
  await page.getByLabel("Template", { exact: true }).selectOption({ label: "Health plan" });
  await page.getByLabel("Use the template").selectOption("as_is");
  await page.getByRole("button", { name: "Plan mission" }).click();
  // As is: no planner runs; the template's plan is proposed at once.
  const plan = page.getByTestId("plan-panel");
  await expect(plan).toBeVisible();
  await expect(plan.getByTestId("planned-task")).toHaveCount(1);
  await expect(plan).toContainText("Write the health endpoint plan");
});
