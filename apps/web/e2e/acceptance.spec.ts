// M0 acceptance (docs/BUILD_PLAN.md): sign in, create workspace, invite member (email logged locally), switch
// workspace; POST /missions writes events that the board shows live over SSE; a reconnect resumes without gaps.
import { createDb, EventWriter, schema } from "@brio/db";
import { eq } from "drizzle-orm";
import { E2E_DATABASE_URL } from "../playwright.config";
import { createWorkspace, expect, lastMail, signIn, test, uniqueEmail } from "./fixtures";

test("sign in, create a workspace, invite a member who joins, switch workspace", async ({
  page,
  browser,
}) => {
  const alice = uniqueEmail("alice");
  const bob = uniqueEmail("bob");

  await signIn(page, alice);
  await expect(page.getByRole("heading", { name: "Create a workspace first" })).toBeVisible();
  await createWorkspace(page, "Acme");
  await expect(page.getByRole("heading", { name: "No missions yet" })).toBeVisible();

  await page.getByRole("link", { name: "Settings" }).first().click();
  await page.getByLabel("Invite by email").fill(bob);
  await page.getByRole("button", { name: "Send invite" }).click();
  await expect(page.getByRole("status")).toHaveText(`invitation sent to ${bob}`);
  await expect(page.getByRole("list", { name: "Members" })).toContainText(`${bob}`);

  const invite = await lastMail(bob);
  expect(invite.subject).toContain("invited you to Acme");
  const invitePath = new URL(invite.link).pathname;

  const bobContext = await browser.newContext();
  const bobPage = await bobContext.newPage();
  await signIn(bobPage, bob, invitePath);
  await bobPage.getByRole("button", { name: "Accept invitation" }).click();
  await expect(bobPage).toHaveURL(/\/missions$/);
  await expect(bobPage.getByTestId("workspace-switcher")).toHaveText("Acme");
  await bobContext.close();

  await page.reload();
  await expect(page.getByRole("list", { name: "Members" })).toContainText(bob);

  await createWorkspace(page, "Beta");
  await page.getByTestId("workspace-switcher").click();
  await page.getByRole("menuitemradio", { name: /Acme/ }).click();
  await expect(page.getByTestId("workspace-switcher")).toHaveText("Acme");
});

test("a new mission's events stream live to the board and resume after a reconnect", async ({ page }) => {
  await signIn(page, uniqueEmail("runner"));
  await createWorkspace(page, "Missions");
  await page.getByLabel("New mission").fill("Add passkey sign-in to the web app, with tests");

  // while the mission is being planned the header cursor blinks (brand/BRAND.md §1)
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  await page.route("**/v1/missions", async (route) => {
    if (route.request().method() === "POST") await held;
    await route.continue();
  });
  const cursor = page.getByTestId("brio-cursor");
  await expect(cursor).toHaveAttribute("data-state", "idle");
  await page.getByRole("button", { name: "Plan mission" }).click();
  await expect(cursor).toHaveAttribute("data-state", "running");
  await expect(cursor).toHaveCSS("animation-name", "brio-blink");
  release();
  await expect(page).toHaveURL(/\/missions\/[0-9a-f-]{36}$/);

  const stream = page.getByTestId("event-stream");
  await expect(page.getByTestId("connection")).toHaveAttribute("data-state", "live");
  await expect(stream.locator("li[data-seq]")).toHaveCount(2);
  await expect(stream.locator('li[data-seq="1"]')).toHaveAttribute("data-type", "mission.created");
  // No agents yet: planning waits, and the board says what to do.
  await expect(stream.locator('li[data-seq="2"]')).toHaveAttribute("data-type", "mission.blocked");
  await expect(page.getByTestId("mission-blocked")).toContainText("no agents yet");
  await expect(
    page.getByTestId("mission-blocked").getByRole("link", { name: "add a connector" }),
  ).toBeVisible();
  await expect(page.getByText("brio.plan")).toBeVisible();

  // events written by the system after the page loaded arrive live
  const missionId = page.url().split("/").at(-1)!;
  const { db, close } = createDb(E2E_DATABASE_URL, { max: 2 });
  try {
    const [m] = await db.select().from(schema.missions).where(eq(schema.missions.id, missionId));
    const writer = new EventWriter({ redactDeep: (v) => v });
    const emit = (n: number) =>
      writer.append(db, {
        workspaceId: m!.workspaceId,
        missionId,
        type: "attempt.message",
        actor: "system",
        payload: { n },
      });
    await emit(3);
    await expect(stream.locator('li[data-seq="3"]')).toBeVisible();

    // the API closes SSE connections after BRIO_SSE_MAX_CONNECTION_MS (2s in e2e); EventSource reconnects with
    // Last-Event-ID. Write steadily across several reconnects: every event must arrive exactly once, in order.
    for (let n = 4; n <= 20; n++) {
      await emit(n);
      await page.waitForTimeout(350);
    }
    await expect(stream.locator('li[data-seq="20"]')).toBeVisible({ timeout: 15_000 });
    const opens = Number(await page.getByTestId("connection").getAttribute("data-opens"));
    expect(opens).toBeGreaterThanOrEqual(2);
    const seqs = await stream
      .locator("li[data-seq]")
      .evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-seq"))));
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  } finally {
    await close();
  }
});
