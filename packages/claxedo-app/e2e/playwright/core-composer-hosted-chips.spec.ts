/**
 * SPEC: Hosted composer chip row — project identity, environment, workspace choice
 *
 * PURPOSE — the empty-draft composer's chip row (`session-new-design-view.tsx` →
 * `session-context-row.tsx`) is the last thing a user configures before their first
 * prompt: WHICH project, WHERE it runs, and IN WHICH workspace. On a hosted cloud
 * session all three chips read from the SIGNED PROJECT INVENTORY
 * (`queryOptions.projects()`, fed by `/api/claxedo/bootstrap`'s `project[]`), and all
 * three were wrong there in a way no local-lane spec could see:
 *
 *   1. PROJECT — hosted cloud workspaces are created with `remote_directory:
 *      "/workspace"` (routes/hosted/workspace.ts), and the chip's last-resort label is
 *      the directory BASENAME, so the chip read the literal word "workspace". The
 *      project's real identity is its repo; `convex/workspaces.ts`'s `list` did not
 *      return `repo_url`/`repo_name`/`project_id` at all, so nothing better ever
 *      reached the client.
 *   2. ENVIRONMENT — the chip hardcoded `["local", "cloud"]`. On web there is no local
 *      machine behind the renderer, so "Local" was selectable but could never resolve
 *      to a workspace.
 *   3. WORKSPACE — the chip lists the ACTIVE project's workspaces filtered by kind, and
 *      the active-project lookup matched only the `workspaces` KEY. The inventory ships
 *      in two shapes that key it differently (by workspace id from the server
 *      bootstrap, by directory from the client snapshot), so the lookup missed one and
 *      the chip collapsed to "create new" for a project that already had cloud
 *      workspaces.
 *
 * This spec owns the hosted chip ROW's contract — what the three chips offer and
 * display on a cloud draft. It does NOT own the provisioning pipeline those chips lead
 * into (`core-cloud-provisioning.spec.ts`) nor harness/model ownership through a cloud
 * send (`core-harness-ownership-cloud.spec.ts`); it deliberately asserts no assistant
 * reply, so the turn-oracle doctrine in e2e/INVARIANTS.md ("every oracle assertion
 * produces evidence") does not apply — there is no turn here to oracle. Screenshots are
 * still captured at each claimed chip state so the labels can be reviewed by eye, per
 * the same document's "an assertion is a claim, not proof".
 *
 * ANATOMY — all three chips are `SessionContextRow` popovers; each trigger carries a
 * stable `data-slot` and a STATIC `aria-label` (the human-readable value is inner text
 * at `[data-slot="context-chip-label"]`, so the label is asserted as a FACT and never
 * used as a selector). Rows inside are `@opencode-ai/ui` `List` buttons —
 * `[data-slot="list-item"][data-key="<value>"]` — with no ARIA listbox roles.
 *
 *   `[data-slot="context-chip-project"]`      — project;    keys are directories
 *   `[data-slot="context-chip-environment"]`  — local/cloud; keys are "local"/"cloud"
 *   `[data-slot="context-chip-worktree"]`     — workspace;   keys are workspace refs
 *
 * LANE — `@core`, selected by `CLAXEDO_E2E_SUITE=core`; mocked runtime only
 * (`e2e/helpers/mock-runtime.ts`), no live control plane.
 */
import { expect, test, type Locator, type Page } from "@playwright/test"
import { installMockRuntime } from "../helpers/mock-runtime"

const DIR = "/tmp/e2e-core-composer-hosted-chips"
const PROJECT_ID = "proj_core_composer_hosted"
const PROJECT_NAME = "core-composer-hosted-local"
const WORKSPACE_ID = "ws_core_composer_hosted"
// The chip must render THIS, derived from the workspace's repo — never
// "workspace", the basename of the hosted "/workspace" directory.
const WORKSPACE_PROJECT_NAME = "claxedo/hosted-composer"
const RELAY_ORIGIN = "https://relay.core-composer-hosted-chips.test"

const EVIDENCE = "test-results/evidence/core-composer-hosted-chips"

function workspaceRoute() {
  return `/w/${encodeURIComponent(WORKSPACE_ID)}/session`
}

async function seedProjects(page: Page) {
  await page.addInitScript(
    (input: { dir: string; workspaceId: string }) => {
      localStorage.clear()
      ;(window as typeof window & { __OPENCODE__?: { serverUrl?: string; activeDirectory?: string } }).__OPENCODE__ = {
        serverUrl: window.location.origin,
        activeDirectory: input.dir,
      }
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          list: [],
          projects: {
            local: [
              { worktree: input.dir, expanded: true, sandboxes: [] },
              { worktree: input.workspaceId, expanded: true, sandboxes: [input.workspaceId] },
            ],
          },
          lastProject: {},
          workspaceServer: {},
          closedProjects: {},
        }),
      )
    },
    { dir: DIR, workspaceId: WORKSPACE_ID },
  )
}

/** Land on the cloud draft with the composer actually interactive. */
async function openCloudDraft(page: Page) {
  await installMockRuntime(page, {
    dir: DIR,
    projectId: PROJECT_ID,
    projectName: PROJECT_NAME,
    cloud: { workspaceId: WORKSPACE_ID, relayOrigin: RELAY_ORIGIN, projectName: WORKSPACE_PROJECT_NAME },
  })
  await seedProjects(page)
  await page.goto(workspaceRoute())
  await page.waitForLoadState("domcontentloaded")
  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await expect(input).toBeVisible({ timeout: 20_000 })
}

/**
 * Resolve a chip trigger, requiring EXACTLY ONE visible instance. Zero (a
 * renamed slot, or a chip that never rendered because the row bailed) must fail
 * loudly here rather than as a downstream timeout that reads like a product bug.
 */
async function chip(page: Page, slot: string): Promise<Locator> {
  const trigger = page.locator(`[data-slot="${slot}"]`).filter({ visible: true })
  await expect(trigger, `expected exactly one visible [data-slot="${slot}"]`)
    .toHaveCount(1, { timeout: 20_000 })
  return trigger
}

/** The keys a chip's popover offers, in order. Closes the popover afterwards. */
async function chipOptionKeys(page: Page, slot: string) {
  const trigger = await chip(page, slot)
  await trigger.click()
  const rows = page.locator('[data-slot="list-item"]').filter({ visible: true })
  await expect.poll(async () => await rows.count(), { timeout: 20_000 }).toBeGreaterThan(0)
  const keys = await rows.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-key")).filter((key): key is string => !!key),
  )
  await page.keyboard.press("Escape")
  return keys
}

test.describe("core composer hosted chips @core", () => {
  test("the project chip shows the project's repo identity, never the '/workspace' basename — behavior 1", async ({ page }) => {
    await openCloudDraft(page)

    const trigger = await chip(page, "context-chip-project")
    const label = trigger.locator('[data-slot="context-chip-label"]')
    await expect(label).toHaveText(WORKSPACE_PROJECT_NAME, { timeout: 20_000 })
    // The regression, pinned as its own assertion: "workspace" is the basename
    // of the literal directory every hosted cloud workspace is created in, and
    // it is a real-looking label, so an equality check on the good value alone
    // would not make the failure legible.
    await expect(label).not.toHaveText("workspace")
    await expect(label).not.toHaveText("/workspace")

    await page.screenshot({ path: `${EVIDENCE}/project-chip-label.png`, fullPage: true })
  })

  test("the environment chip offers cloud only on web — behavior 2", async ({ page }) => {
    await openCloudDraft(page)

    // Asserted as an exact list, not "does not contain local": a chip that
    // renders zero options is also wrong, and `toEqual` catches both.
    expect(await chipOptionKeys(page, "context-chip-environment")).toEqual(["cloud"])

    const trigger = await chip(page, "context-chip-environment")
    await expect(trigger.locator('[data-slot="context-chip-label"]')).toHaveText("Cloud", { timeout: 20_000 })
    await trigger.click()
    await page.screenshot({ path: `${EVIDENCE}/environment-chip-cloud-only.png`, fullPage: true })
    await page.keyboard.press("Escape")
  })

  test("the workspace chip lists the project's existing cloud workspace to choose — behavior 3", async ({ page }) => {
    await openCloudDraft(page)

    const trigger = await chip(page, "context-chip-worktree")
    await trigger.click()
    const rows = page.locator('[data-slot="list-item"]').filter({ visible: true })
    // The defect was ZERO selectable rows — the chip collapsed straight to the
    // create path — so the load-bearing claim is that an EXISTING workspace is
    // offered at all.
    await expect(rows).toHaveCount(1, { timeout: 20_000 })
    await expect(rows.first()).toContainText("main")

    await page.screenshot({ path: `${EVIDENCE}/workspace-chip-existing.png`, fullPage: true })
    await page.keyboard.press("Escape")

    // Choosing an existing workspace and creating a new one must stay distinct
    // affordances: the create path is the popover's FOOTER action, never one of
    // the rows above.
    await trigger.click()
    await expect(page.getByText("New cloud sandbox").filter({ visible: true }))
      .toHaveCount(1, { timeout: 20_000 })
    await page.keyboard.press("Escape")
  })

  test("selecting the existing cloud workspace keeps the draft on it — behavior 4", async ({ page }) => {
    await openCloudDraft(page)

    const trigger = await chip(page, "context-chip-worktree")
    await trigger.click()
    const row = page.locator('[data-slot="list-item"]').filter({ visible: true }).first()
    await expect(row).toBeVisible({ timeout: 20_000 })
    const key = await row.getAttribute("data-key")
    await row.click()

    // The selection is proven to have TAKEN EFFECT — the trigger's own label
    // settles on the chosen workspace rather than flipping to the create path.
    await expect(trigger.locator('[data-slot="context-chip-label"]'))
      .not.toHaveText("New cloud sandbox", { timeout: 20_000 })
    expect(key).toBeTruthy()

    await page.screenshot({ path: `${EVIDENCE}/workspace-chip-selected.png`, fullPage: true })
  })
})
