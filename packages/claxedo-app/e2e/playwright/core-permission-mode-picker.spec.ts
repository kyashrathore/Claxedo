/**
 * The composer's permission picker, which renders whatever the runtime reports for the
 * selected harness in that harness's own vocabulary. One word cannot cover four products:
 * "Auto" is a persisted engine ruleset on opencode, a model classifier on Claude, an OS
 * sandbox on Codex, and in-process prompt answering on ACP. Claxedo names an option only
 * where the harness has none.
 *
 * The harness is the store. `GET /permission/modes?directory=` answers for a draft, which
 * has no session yet; `GET|PUT /session/:id/permission-mode` answers for a live one.
 * `defaultPermissionSelection` reads the harness's `currentModeId` first, so a resumed
 * session shows the mode genuinely in force rather than a Claxedo copy of it.
 *
 * A choice reaches the harness by two paths and both are asserted: `permissionMode` on the
 * prompt body, which is the only path for the first turn because that request is what
 * creates the session, and the PUT route mid-session.
 *
 * The opencode ruleset write belongs to core-permission-ruleset-delivery.spec.ts, and
 * Claxedo's local auto-answering of `permission.asked` is separate from all of this.
 */
import { expect, test, type Page } from "@playwright/test"
import { installMockRuntime, type Harness } from "../helpers/mock-runtime"
import { selectSignedHarness } from "../helpers/web-signed-relay-harness"

const DIR = "/tmp/e2e-core-permission-mode-picker"
const SESSION_ID = "ses_perm_mode_picker"

const trigger = (page: Page) => page.locator('[data-action="prompt-permission-mode"]')
const rows = (page: Page) => page.locator('[role="menuitem"][data-mode]')

/** Open the picker: one flat list, no disclosure control to expand first. */
async function openPicker(page: Page) {
  const control = trigger(page).last()
  await expect(control).toBeVisible({ timeout: 20_000 })
  await control.click()
  await expect(rows(page).first()).toBeVisible({ timeout: 10_000 })
  return control
}

/** Ids in menu order, which is the order the runtime reported them. */
async function rowIds(page: Page) {
  return await rows(page).evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-mode") ?? ""))
}

async function seedDraft(page: Page, harness: Harness) {
  const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, harness })
  await page.goto("/")
  return mock
}

test.describe("@core permission picker — the harness's own modes", () => {
  /**
   * A draft is the only moment a choice can still govern the first turn, so it carries the
   * heaviest assertions here.
   *
   * `auto` is the rung the runtime reports at `level: "auto"`, and `label` is the name the
   * trigger must show for it — the harness's own word, never "Auto" unless the harness
   * itself says "Auto".
   */
  const DRAFT_CASES: { harness: Harness; ids: string[]; auto: string; label: RegExp }[] = [
    {
      harness: "claude-sdk",
      ids: ["default", "acceptEdits", "auto", "plan", "dontAsk", "bypassPermissions"],
      auto: "acceptEdits",
      label: /^Accept edits$/i,
    },
    {
      harness: "codex-app-server",
      ids: ["read-only", "workspace-write", "untrusted", "full-access"],
      auto: "workspace-write",
      label: /^Workspace write$/i,
    },
    {
      harness: "cursor-sdk",
      ids: ["review", "auto-review", "unsandboxed"],
      auto: "auto-review",
      label: /^Auto-review$/i,
    },
    // ACP agents advertise on session/new, so a draft is answered from the runtime's
    // recorded table for that agent — its own ids, so the draft choice is already the
    // session choice with nothing to re-resolve when the session opens.
    //
    // The list deliberately differs from claude-sdk above, in ids and in order: the two are
    // separate products over separate transports, and letting them converge here would stop
    // this spec noticing if one started answering for the other.
    {
      harness: "acp:claude",
      ids: ["auto", "default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"],
      // claude-agent-acp's own rung is `{ id: "auto", name: "Auto" }`, so "Auto" on the
      // trigger here is the agent's word, not Claxedo's.
      auto: "auto",
      label: /^Auto$/i,
    },
    { harness: "acp:codex", ids: ["read-only", "agent", "agent-full-access"], auto: "agent", label: /^Agent$/i },
    { harness: "acp:cursor", ids: ["agent", "plan", "ask"], auto: "agent", label: /^Agent$/i },
  ]

  for (const item of DRAFT_CASES) {
    test(`${item.harness}: a draft shows the harness's modes and marks every row selectable`, async ({ page }) => {
      await seedDraft(page, item.harness)

      await openPicker(page)

      // The trigger names the harness's own rung and the whole list is on screen at once.
      // A Claxedo label over the list would read the same on every harness, and could not
      // be checked against the row actually carrying the check.
      await expect(trigger(page).last()).toHaveText(item.label)
      expect(await rowIds(page)).toEqual(item.ids)
      await expect(
        page.locator(`[role="menuitem"][data-mode="${item.auto}"][data-checked]`),
        "the row in force must be the one the trigger names",
      ).toHaveCount(1)
      // No collapsed summary survives anywhere.
      await expect(page.locator('[data-action="permission-modes-expand"]')).toHaveCount(0)
      await expect(page.locator('[data-mode="claxedo-allow-safe"]')).toHaveCount(0)

      // No row may be blocked. `data-selectable` is written from
      // `permissionModeDeliverable`, so this fails the moment a delivery is offered
      // without an implementation behind it.
      const selectable = await rows(page).evaluateAll((nodes) =>
        nodes.map((n) => n.getAttribute("data-selectable")),
      )
      expect(new Set(selectable), "every reported mode must be choosable").toEqual(new Set(["true"]))

      // Nothing reads as loading, and no Claxedo group appears beside harness modes —
      // the two groups are mutually exclusive, and an empty header reads as a list that
      // failed to load.
      await expect(page.getByText(/Loading .*permission modes/i)).toHaveCount(0)
      await expect(page.getByText("Claxedo", { exact: true })).toHaveCount(0)

    })
  }

  // The modes fetch is keyed on harness, so a switch invalidates the previous answer
  // rather than leaving its rows up until a slower fetch lands.
  test("switching harness replaces the modes rather than leaving stale ones", async ({ page }) => {
    await seedDraft(page, "codex-app-server")
    await openPicker(page)
    expect(await rowIds(page)).toEqual(["read-only", "workspace-write", "untrusted", "full-access"])
    await page.keyboard.press("Escape")

    const modesResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.pathname.endsWith("/permission/modes") && url.searchParams.get("nativeHarness") === "claude"
    })
    await selectSignedHarness(page, "Claude Code", "claude")
    expect((await modesResponse).ok()).toBe(true)
    await openPicker(page)
    await expect.poll(() => rowIds(page)).toEqual(["default", "acceptEdits", "auto", "plan", "dontAsk", "bypassPermissions"])

    const ids = await rowIds(page)
    expect(ids, "no Codex mode may survive the switch").not.toContain("workspace-write")
  })
})

test.describe("@core permission picker — the choice reaches the harness", () => {
  // The first message is what creates the session, so a mode chosen beforehand cannot be
  // written to a session route and has to ride on the prompt instead. The assertion is on
  // the prompt body, not the trigger label: a picker can relabel itself while nothing
  // reaches the runtime.
  test("a mode chosen before the first message rides on that message", async ({ page }) => {
    const mock = await seedDraft(page, "claude-sdk")
    await openPicker(page)

    // Selected by id rather than exact text: rows carry a description beside the
    // name, so an anchored text match breaks whenever the copy is tuned — which
    // is a rewording, not a regression.
    await rows(page).and(page.locator('[data-mode="plan"]')).first().click()
    await expect(trigger(page).last()).toHaveText(/Plan/i)

    await page.getByRole("textbox").first().fill("hello")
    await page.keyboard.press("Enter")

    await expect
      .poll(() => mock.requests.promptBodies.length, { timeout: 20_000 })
      .toBeGreaterThan(0)
    expect(
      mock.requests.promptBodies[0]?.permissionMode,
      "the first prompt must carry the chosen mode, or the opening turn runs under a default nobody picked",
    ).toBe("plan")
  })

  // Mid-session the PUT route is the path. Recorded writes, not labels, for the same
  // reason.
  test("changing the mode on a live session writes it to the runtime", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, harness: "codex-app-server" })
    await page.goto(`/s/${SESSION_ID}`)
    await openPicker(page)

    expect(mock.requests.permissionModeWrites).toHaveLength(0)
    await rows(page).and(page.locator('[data-mode="full-access"]')).first().click()

    await expect.poll(() => mock.requests.permissionModeWrites.length, { timeout: 15_000 }).toBe(1)
    expect(mock.requests.permissionModeWrites[0]).toEqual({ modeId: "full-access" })
  })

})
