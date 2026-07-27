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

const DIR = "/tmp/e2e-core-permission-mode-picker"
const SESSION_ID = "ses_perm_mode_picker"

const trigger = (page: Page) => page.locator('[data-action="prompt-permission-mode"]')
const rows = (page: Page) => page.locator('[role="menuitem"][data-mode]')

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
  const DRAFT_CASES: { harness: Harness; ids: string[]; label: RegExp }[] = [
    {
      harness: "claude-sdk",
      ids: ["default", "acceptEdits", "auto", "plan", "dontAsk", "bypassPermissions"],
      label: /Accept edits/i,
    },
    {
      harness: "codex-app-server",
      ids: ["read-only", "workspace-write", "untrusted", "full-access"],
      label: /Workspace write/i,
    },
    { harness: "cursor-sdk", ids: ["review", "auto-review", "unsandboxed"], label: /Auto-review/i },
    // ACP agents advertise on session/new, so a draft gets the RUNGS. They are intents,
    // resolved to the agent's real ids at session start — without them the draft fell back
    // to Claxedo's options, which are discarded the instant the session opens.
    { harness: "claude-acp", ids: ["ask", "auto", "full"], label: /Allow everything except danger/i },
  ]

  for (const item of DRAFT_CASES) {
    test(`${item.harness}: a draft shows the harness's modes, all selectable — behaviors 1,2`, async ({ page }) => {
      await seedDraft(page, item.harness)
      await openPicker(page)

      expect(await rowIds(page)).toEqual(item.ids)

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

      // The auto rung is the default: allow reads and edits, ask before anything risky.
      await expect(trigger(page).last()).toHaveText(item.label)
    })
  }

  // opencode has RULES, not modes. It must say so and fall back to Claxedo's own two
  // options rather than rendering an empty harness group.
  test("opencode falls back to Claxedo's options and says why — behavior 5", async ({ page }) => {
    await seedDraft(page, "opencode")
    await openPicker(page)

    expect(await rowIds(page)).toEqual(["claxedo-allow-safe", "claxedo-ask-always"])
    await expect(page.getByText(/opencode has no permission modes of its own/i)).toBeVisible()
    // Named for what they do. "Auto" named a Claxedo abstraction and told the user
    // nothing about what would actually happen.
    //
    // The DEFAULT here is the restrictive option, unlike every harness above, and that
    // asymmetry is real rather than an oversight: Claxedo's selection derives from the
    // per-scope auto-accept preference, which starts off. So opencode asks until the
    // user opts in, while a harness with its own modes starts on its auto rung.
    await expect(trigger(page).last()).toHaveText(/Ask for everything/i)
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

    await rows(page).filter({ hasText: /^Plan$/ }).first().click()
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
    await rows(page).filter({ hasText: /^Full access$/ }).first().click()

    await expect.poll(() => mock.requests.permissionModeWrites.length, { timeout: 15_000 }).toBe(1)
    expect(mock.requests.permissionModeWrites[0]).toEqual({ modeId: "full-access" })
  })

  // Claxedo's own ids are not ids any harness would recognise. Forwarding one would have
  // the runtime try to set a mode that does not exist, so opencode's selection must reach
  // the engine as a RULESET and never as `permissionMode`.
  test("a Claxedo option is never smuggled onto the prompt as a harness mode", async ({ page }) => {
    const mock = await seedDraft(page, "opencode")
    await openPicker(page)
    await rows(page).filter({ hasText: /^Ask for everything$/ }).first().click()

    await page.getByRole("textbox").first().fill("hello")
    await page.keyboard.press("Enter")

    await expect.poll(() => mock.requests.promptBodies.length, { timeout: 20_000 }).toBeGreaterThan(0)
    expect(mock.requests.promptBodies[0]?.permissionMode).toBeUndefined()
  })
})
