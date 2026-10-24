// Agents can be changed in place: model, price, role prompt and limit.
import { createWorkspace, expect, signIn, test, uniqueEmail } from "./fixtures";

const FAKE_VENDOR = `http://127.0.0.1:${process.env.FAKE_VENDOR_PORT ?? 4300}/v1`;

test("edit an agent's price, role prompt and limit", async ({ page }) => {
  await signIn(page, uniqueEmail("editor"));
  await createWorkspace(page, "Editing");
  await page.goto("/connectors");
  const row = page.getByTestId("catalogue-litellm");
  await row.getByRole("button", { name: "Add key" }).click();
  await row.getByLabel(/Base URL/).fill(FAKE_VENDOR);
  await row.getByLabel(/API key/).fill("e2e-proxy-key-0005");
  await row.getByRole("button", { name: "Add LiteLLM proxy" }).click();
  await expect(page.getByTestId("installed-connector").getByText(/healthy/)).toBeVisible();

  await page.goto("/agents");
  await page.getByLabel("Name", { exact: true }).fill("helper");
  await page.getByLabel(/^Model/).fill("fake-model");
  await page.getByRole("button", { name: "Save agent" }).click();
  const agent = page.getByTestId("agent");
  await expect(agent).toContainText("helper");

  await agent.getByRole("button", { name: "Edit" }).click();
  const form = page.getByRole("form", { name: "Edit helper" });
  await form.getByLabel("Your price, $ per M input tokens").fill("0.5");
  await form.getByLabel("Your price, $ per M output tokens").fill("1.5");
  await form.getByLabel("Role prompt").fill("You answer briefly.");
  await form.getByLabel("Max $ per attempt").fill("0.25");
  await form.getByRole("button", { name: "Save changes" }).click();
  await expect(form).toHaveCount(0);
  await expect(agent).toContainText("$0.5 / $1.5 per M");
  await expect(agent).toContainText("You answer briefly.");
  await expect(agent).toContainText("max $0.25");

  // Half a price is refused, with a reason.
  await agent.getByRole("button", { name: "Edit" }).click();
  await page
    .getByRole("form", { name: "Edit helper" })
    .getByLabel("Your price, $ per M output tokens")
    .fill("");
  await page.getByRole("form", { name: "Edit helper" }).getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Set both prices, or neither")).toBeVisible();
});
