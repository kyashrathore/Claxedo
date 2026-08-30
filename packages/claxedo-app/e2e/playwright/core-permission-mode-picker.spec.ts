/**
 * SPEC: the permission picker shows each harness's OWN modes, and a choice made
 * before the first message governs that message
 *
 * PURPOSE — the composer's permission control used to name modes itself ("Auto",
 * "Manual"). That was lossy by construction: "Auto" meant a persisted engine ruleset on
 * opencode, a model classifier on Claude, an OS sandbox on Codex, and Claxedo answering
 * prompts in-process on ACP — four different guarantees under one word. The picker now
 * renders whatever the RUNTIME reports for the selected harness, in the harness's own
 * vocabulary, and Claxedo names an option only where the harness genuinely has none.
 *
 * WHY THESE ASSERTIONS — every behaviour below is one that actually shipped broken during
 * this feature's development, which is why each is pinned rather than trusted:
 *   1. the picker sat on "Loading …'s permission modes" forever on every draft, because a
 *      draft has no session and the fetch was session-scoped;
 *   2. rows rendered but could not be selected, because the app held per-SDK delivery
 *      shapes it had no implementation for;
 *   3. the first turn ran under a default nobody chose, because the only way to set a
 *      mode was a route that requires a session the first message itself creates;
 *   4. switching harness left the previous harness's modes on screen;
 *   5. an empty "Claxedo" group header rendered above nothing.
 *
 * STATE MODEL —
 *   The harness is the STORE for its own modes. `GET /permission/modes?directory=` answers
 *   for a draft (directory-scoped, because Claude/Codex/Cursor tables are static and ACP
 *   honestly reports rungs); `GET|PUT /session/:id/permission-mode` answers for a live
 *   session. Claxedo keeps no parallel copy — `defaultPermissionSelection` reads the
 *   harness's own `currentModeId` first, so a resumed session shows the mode genuinely in
 *   force.
 *   A choice reaches the harness by TWO paths, and both are asserted here: `permissionMode`
 *   on the prompt body (which is the only path available for the first turn, since the
 *   session does not exist until that request), and the PUT route for changes mid-session.
 *
 * OUT OF SCOPE — the opencode ruleset write itself, owned by
 * core-permission-ruleset-delivery.spec.ts; and Claxedo's local auto-answering of
 * `permission.asked`, which predates all of this.
 */
import { expect, test, type Page } from "@playwright/test"
import { installMockRuntime, type Harness } from "../helpers/mock-runtime"
import { ensureComposerModelSelected } from "../helpers/turn-oracle"

const DIR = "/tmp/e2e-core-permission-mode-picker"
const SESSION_ID = "ses_perm_mode_picker"

const trigger = (page: Page) => page.locator('[data-action="prompt-permission-mode"]')
const rows = (page: Page) => page.locator('[role="menuitem"][data-mode]')

/**
 * Open the picker.
 *
 * One flat list, no disclosure. The menu used to open on a single collapsed
 * Claxedo "Auto" row with the harness's real modes behind a "N more …" control,
 * and these specs each had to expand before they could read a list — a step that
 * existed only because Auto was a label over one of the rows it was hiding.
 */
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
  // Behaviour 1 + 2. A DRAFT is the case that shipped as a permanent spinner, and it is
  // also the only moment the choice can govern the first turn — so it is asserted first
  // and hardest. Every row must be selectable: a row that renders but cannot be chosen is
  // the second bug this feature shipped with.
  /**
   * `auto` is the rung the runtime reports at `level: "auto"`, and `label` is
   * the name it must show ON THE TRIGGER — the harness's own word for it, never
   * "Auto" unless the harness itself says "Auto".
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
    // recorded table for that agent — its OWN ids, not three rungs Claxedo named. The
    // draft choice is therefore the session choice, with nothing to re-resolve when the
    // session opens.
    //
    // Deliberately a different list from claude-sdk above, in a different order: the two
    // are separate products reached over separate transports, and a spec that let them
    // converge would stop noticing if one started answering for the other.
    {
      harness: "claude-acp",
      ids: ["auto", "default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"],
      // claude-agent-acp's rung is literally `{ id: "auto", name: "Auto" }`, so
      // "Auto" on the trigger here is the AGENT's word, not Claxedo's.
      auto: "auto",
      label: /^Auto$/i,
    },
    { harness: "codex-acp", ids: ["read-only", "agent", "agent-full-access"], auto: "agent", label: /^Agent$/i },
    { harness: "cursor-acp", ids: ["agent", "plan", "ask"], auto: "agent", label: /^Agent$/i },
  ]

  for (const item of DRAFT_CASES) {
    test(`${item.harness}: a draft shows the harness's modes, all selectable — behaviors 1,2`, async ({ page }) => {
      await seedDraft(page, item.harness)

      await openPicker(page)

      /*
       * The trigger names the harness's OWN rung, and the whole list is on
       * screen at once.
       *
       * Both used to be false: the menu opened on a single Claxedo row called
       * "Auto" that merely pointed at the rung below, with the real list behind
       * a "N more …" disclosure. The trigger therefore read "Auto" on every
       * harness — including Claude, whose own list contains a row named "Auto"
       * that this was NOT selecting. Asserting the harness's word is what makes
       * the label checkable against the row carrying the check.
       */
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

  // opencode has RULES, not modes. It must say so and fall back to Claxedo's own two
  // options rather than rendering an empty harness group.
  test("opencode falls back to Claxedo's options and says why — behavior 5", async ({ page }) => {
    await seedDraft(page, "opencode")
    await openPicker(page)

    expect(await rowIds(page)).toEqual(["claxedo-allow-safe", "claxedo-ask-always"])
    await expect(page.getByText(/opencode has no permission modes of its own/i)).toBeVisible()
    // Named for what they do. "Auto" is Claxedo's permissive local-answer option;
    // "Ask for everything" is the restrictive off switch.
    //
    // With no harness modes, `defaultPermissionSelection` starts on
    // `claxedo-allow-safe` (see modes.test.ts) — unlike harness-backed drafts that
    // start on the harness's own auto rung.
    await expect(trigger(page).last()).toHaveText(/^Auto$/i)
    await expect(
      page.locator('[role="menuitem"][data-mode="claxedo-allow-safe"][data-checked]'),
    ).toHaveCount(1)
  })

  // Behaviour 4. Keying the fetch on harness is what makes a switch invalidate the
  // previous answer; without it the old harness's rows stayed on screen until a slower
  // fetch landed, which reads as the switch not having worked.
  test("switching harness replaces the modes rather than leaving stale ones — behavior 4", async ({ page }) => {
    await seedDraft(page, "codex-app-server")
    await openPicker(page)
    expect(await rowIds(page)).toEqual(["read-only", "workspace-write", "untrusted", "full-access"])
    await page.keyboard.press("Escape")

    // Re-install the runtime as a different harness, which is what the harness switcher
    // effectively does from the picker's point of view.
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, harness: "claude-sdk" })
    await page.reload()
    await openPicker(page)

    const ids = await rowIds(page)
    expect(ids).toEqual(["default", "acceptEdits", "auto", "plan", "dontAsk", "bypassPermissions"])
    expect(ids, "no Codex mode may survive the switch").not.toContain("workspace-write")
  })
})

test.describe("@core permission picker — the choice reaches the harness", () => {
  // Behaviour 3, and the one that matters most. The session is created BY the first
  // message, so a mode chosen beforehand cannot be written to a session that does not
  // exist — it has to ride on the prompt. Asserting on the PROMPT BODY rather than on the
  // trigger label is deliberate: a picker can change its own label while nothing reaches
  // the runtime, which is exactly how this shipped broken.
  test("a mode chosen before the first message is sent WITH that message — behavior 3", async ({ page }) => {
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
  // reason as above.
  test("changing the mode on a live session writes it to the runtime", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, harness: "codex-app-server" })
    await page.goto(`/s/${SESSION_ID}`)
    await openPicker(page)

    expect(mock.requests.permissionModeWrites).toHaveLength(0)
    await rows(page).and(page.locator('[data-mode="full-access"]')).first().click()

    await expect.poll(() => mock.requests.permissionModeWrites.length, { timeout: 15_000 }).toBe(1)
    expect(mock.requests.permissionModeWrites[0]).toEqual({ modeId: "full-access" })
  })

  // Claxedo's own ids are not ids any harness would recognise. Forwarding one would have
  // the runtime try to set a mode that does not exist, so opencode's selection must reach
  // the engine as a RULESET and never as `permissionMode`.
  test("a Claxedo option is never smuggled onto the prompt as a harness mode", async ({ page }) => {
    const mock = await seedDraft(page, "opencode")
    await ensureComposerModelSelected(page, { modelName: /^Big Pickle$/i, search: "Big Pickle" })
    await openPicker(page)
    await rows(page).and(page.locator('[data-mode="claxedo-ask-always"]')).first().click()
    await page.keyboard.press("Escape")

    const input = page.getByRole("textbox").first()
    await input.fill("hello")
    await page.locator('[data-action="prompt-submit"]').last().click()

    await expect.poll(() => mock.requests.promptBodies.length, { timeout: 20_000 }).toBeGreaterThan(0)
    expect(mock.requests.promptBodies[0]?.permissionMode).toBeUndefined()
  })
})
