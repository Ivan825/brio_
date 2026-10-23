// M8 acceptance (docs/BUILD_PLAN.md): create a mission → edit its plan → approve it → watch it live → approve the PR
// action → read the report. The planner and the coder are the fake OpenAI-compatible vendor; the code task runs in a
// real sandbox on the e2e runner against a local repository; the pull request goes to the fake vendor's GitHub routes.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspace, expect, signIn, test, uniqueEmail } from "./fixtures";

const FAKE_VENDOR = `http://127.0.0.1:${process.env.FAKE_VENDOR_PORT ?? 4300}/v1`;
const GIT_TOKEN = ["github", "pat", "11E2EACCEPT0123456789abcdefghijklmn"].join("_");

test("create a mission, edit its plan, approve it, watch it, approve the pull request, read the report", async ({
  page,
}) => {
  test.setTimeout(600_000);
  const root = mkdtempSync(join(tmpdir(), "brio-e2e-pr-"));
  const repo = join(root, "site.git");
  const seed = join(root, "seed");
  const git = (...a: string[]) =>
    execFileSync("git", a, {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
  git("init", "--bare", "-q", "-b", "main", repo);
  git("clone", "-q", repo, seed);
  git("-C", seed, "commit", "-q", "--allow-empty", "-m", "init");
  git("-C", seed, "push", "-q", "origin", "HEAD:main");

  try {
    await signIn(page, uniqueEmail("accept"));
    await createWorkspace(page, "Acceptance");

    await page.goto("/connectors");
    const row = page.getByTestId("catalogue-litellm");
    await row.getByRole("button", { name: "Add key" }).click();
    await row.getByLabel(/Base URL/).fill(FAKE_VENDOR);
    await row.getByLabel(/API key/).fill("e2e-proxy-key-0004");
    await row.getByRole("button", { name: "Add LiteLLM proxy" }).click();
    await expect(page.getByTestId("installed-connector").getByText(/healthy/)).toBeVisible();
    await page.goto("/agents");
    await page.getByLabel("Name", { exact: true }).fill("builder");
    await page.getByLabel(/^Model/).fill("fake-model");
    await page.getByRole("button", { name: "Save agent" }).click();
    await expect(page.getByTestId("agent")).toContainText("builder");

    await page.goto("/projects");
    const form = page.getByRole("form", { name: "New project" });
    await form.getByLabel("Name", { exact: true }).fill("site");
    await form.getByLabel("Default branch").fill("main");
    await form.getByLabel("Repository", { exact: true }).fill(repo);
    await form.getByLabel("Git token (optional)").fill(GIT_TOKEN);
    await form.getByLabel("GitHub repository for pull requests").fill("acme/site");
    await form.getByRole("button", { name: "Add project" }).click();
    await expect(page.getByTestId("project")).toContainText("token set");

    // Create the mission.
    await page.goto("/missions");
    await page.getByLabel("New mission").fill("Ship the health file");
    await page.getByLabel("Project").selectOption({ label: "site" });
    await page.getByRole("button", { name: "Plan mission" }).click();
    await expect(page).toHaveURL(/\/missions\/[0-9a-f-]{36}$/);

    // Edit the plan, then approve it.
    const panel = page.getByTestId("plan-panel");
    await expect(panel).toBeVisible({ timeout: 60_000 });
    const task = panel.locator('[data-testid="planned-task"][data-key="health-file"]');
    await task.getByRole("button", { name: "Edit" }).click();
    await task.getByLabel("Title").fill("Add the health file, checked");
    await task.getByRole("button", { name: "Save changes" }).click();
    await expect(panel).toHaveAttribute("data-version", "2");
    await panel.getByRole("button", { name: "Approve plan" }).click();

    // Watch it live: the agent writes the file in its sandbox, the check passes, the mission ends.
    const stream = page.getByTestId("event-stream");
    await expect(stream.locator('li[data-type="attempt.started"]').first()).toBeVisible({ timeout: 120_000 });
    await expect(stream.locator('li[data-type="attempt.file_edit"]').first()).toBeVisible({
      timeout: 300_000,
    });
    await expect(stream.locator('li[data-type="check.result"]').first()).toBeVisible({ timeout: 300_000 });
    await expect(stream.locator('li[data-type="mission.done"]')).toHaveCount(1, { timeout: 300_000 });

    // Approve the pull request: the branch is pushed and the pull request opened.
    const delivery = page.getByTestId("delivery");
    await expect(delivery).toHaveAttribute("data-status", "awaiting_approval", { timeout: 30_000 });
    await delivery.getByRole("button", { name: "Approve and open the pull request" }).click();
    await expect(delivery).toHaveAttribute("data-status", "done", { timeout: 120_000 });
    await expect(delivery.getByRole("link", { name: /Pull request #\d+/ })).toBeVisible();
    const branch = execFileSync("git", ["--git-dir", repo, "branch", "--list", "brio/*"]).toString();
    expect(branch).toContain("brio/ship-the-health-file-");

    // Read the report.
    await page.getByRole("link", { name: "report", exact: true }).click();
    const report = page.getByTestId("mission-report");
    await expect(report).toContainText("final report");
    await expect(report.getByTestId("report-task")).toContainText("Add the health file, checked");
    await expect(report.getByTestId("report-task")).toContainText("done");
    await expect(report).toContainText("Integration");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
