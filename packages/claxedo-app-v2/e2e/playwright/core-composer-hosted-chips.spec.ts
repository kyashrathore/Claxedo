/**
 * The empty-draft composer's chip row on a hosted cloud session
 * (`session-new-design-view.tsx` -> `session-context-row.tsx`): which project, where it
 * runs, in which workspace, and from which branch. Mocked runtime only, no live control
 * plane.
 *
 * Every hosted cloud workspace is created with `remote_directory: "/workspace"`, so the
 * chip's last-resort basename label reads as the literal word "workspace"; the project's
 * real identity has to come from the workspace authority's repo fields. The environment
 * chip offers cloud only on web — there is no local machine behind the renderer. The
 * workspace chip lists the active project's workspaces, and the inventory arrives in two
 * shapes keyed differently (by workspace id from the server bootstrap, by directory from
 * the client snapshot), so a lookup that matches only one key collapses the chip to
 * "create new" for a project that already has cloud workspaces.
 *
 * Each chip is a `SessionContextRow` popover whose trigger carries a stable `data-slot`
 * and a static `aria-label`; the human-readable value is inner text at
 * `[data-slot="context-chip-label"]`, so it is asserted as a fact and never used as a
 * selector. Rows inside are `@opencode-ai/ui` `List` buttons
 * (`[data-slot="list-item"][data-key="<value>"]`) with no ARIA listbox roles.
 *
 *   `[data-slot="context-chip-project"]`      — project;    keys are directories
 *   `[data-slot="context-chip-environment"]`  — where the session runs; keys are host kinds
 *   `[data-slot="context-chip-worktree"]`     — workspace;   keys are workspace refs
 *   `[data-slot="context-chip-branch"]`       — base branch; keys are Git refs
 *
 * The branch case follows its selection through the canonical workspace-create payload
 * and one oracle-verified reply; the provisioning state machine itself lives in
 * `core-cloud-provisioning.spec.ts`.
 */
import { expect, test, type Locator, type Page } from "@playwright/test"
import { installMockRuntime } from "../helpers/mock-runtime"
import { expectAssistantReplyVisible, ensureComposerModelSelected, SELECTORS } from "../helpers/turn-oracle"

const DIR = "/tmp/e2e-core-composer-hosted-chips"
const PROJECT_ID = "proj_core_composer_hosted"
const PROJECT_NAME = "core-composer-hosted-local"
const WORKSPACE_ID = "ws_core_composer_hosted"
// The chip renders this, derived from the workspace's repo, never "workspace", the
// basename of the hosted "/workspace" directory.
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
      ;(window as typeof window & { __CLAXEDO__?: { serverUrl?: string; activeDirectory?: string } }).__CLAXEDO__ = {
        serverUrl: window.location.origin,
        activeDirectory: input.dir,
      }
      localStorage.setItem(
        "claxedo.global.dat:server",
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
  const mock = await installMockRuntime(page, {
    dir: DIR,
    projectId: PROJECT_ID,
    projectName: PROJECT_NAME,
    branchChoices: [
      { gitRef: "main", sourceBranch: "main" },
      { gitRef: "origin/feature/e2e", sourceBranch: "feature/e2e" },
    ],
    cloud: { workspaceId: WORKSPACE_ID, relayOrigin: RELAY_ORIGIN, projectName: WORKSPACE_PROJECT_NAME },
  })
  await seedProjects(page)
  await page.goto(workspaceRoute())
  await page.waitForLoadState("domcontentloaded")
  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await expect(input).toBeVisible({ timeout: 20_000 })
  return mock
}

/**
 * Resolves a chip trigger, requiring exactly one visible instance. A renamed slot or a
 * chip the row never rendered fails here by name rather than as a downstream timeout
 * that reads like a product bug.
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

async function selectAgentConnection(page: Page, connectionId: string) {
  const control = page.locator('[data-action="prompt-harness-model"]:visible').last()
  await expect(control).toBeEnabled({ timeout: 20_000 })
  await control.click()
  const picker = page.locator('[data-component="harness-model-picker"]')
  await expect(picker).toBeVisible({ timeout: 15_000 })
  await picker.locator('[data-slot="harness-picker-section"]').first().click()
  const option = picker.getByRole("button", { name: new RegExp(`^${connectionId}$`, "i") })
  await expect(option).toBeVisible({ timeout: 20_000 })
  await option.click()
  await page.keyboard.press("Escape")
  await expect(picker).toBeHidden({ timeout: 10_000 })
  await expect(control).toHaveAttribute("data-harness", connectionId, { timeout: 20_000 })
}

test.describe("core composer hosted chips @core", () => {
  test("the project chip shows the project's repo identity, never the '/workspace' basename", async ({ page }) => {
    await openCloudDraft(page)

    const trigger = await chip(page, "context-chip-project")
    const label = trigger.locator('[data-slot="context-chip-label"]')
    await expect(label).toHaveText(WORKSPACE_PROJECT_NAME, { timeout: 20_000 })
    // Pinned as its own assertion: "workspace" is a real-looking label, so an equality
    // check on the good value alone would not make the failure legible.
    await expect(label).not.toHaveText("workspace")
    await expect(label).not.toHaveText("/workspace")

    await page.screenshot({ path: `${EVIDENCE}/project-chip-label.png`, fullPage: true })
  })

  test("the environment chip offers cloud only on web", async ({ page }) => {
    await openCloudDraft(page)

    // An exact list, not "does not contain self": a chip that renders zero options is
    // also wrong, and `toEqual` catches both. The key is the option's value, which
    // `onSelect` hands back to `onHostKindChange` — a host kind, never a wire word.
    expect(await chipOptionKeys(page, "context-chip-environment")).toEqual(["provisioner"])

    const trigger = await chip(page, "context-chip-environment")
    await expect(trigger.locator('[data-slot="context-chip-label"]')).toHaveText("Cloud environment", { timeout: 20_000 })
    await trigger.click()
    await page.screenshot({ path: `${EVIDENCE}/environment-chip-cloud-only.png`, fullPage: true })
    await page.keyboard.press("Escape")
  })

  test("the workspace chip lists the project's existing cloud workspace to choose", async ({ page }) => {
    await openCloudDraft(page)

    const trigger = await chip(page, "context-chip-worktree")
    await trigger.click()
    const rows = page.locator('[data-slot="list-item"]').filter({ visible: true })
    // The load-bearing claim is that an existing workspace is offered at all: the
    // failure mode is a chip that collapses straight to the create path.
    await expect(rows).toHaveCount(1, { timeout: 20_000 })
    await expect(rows.first()).toContainText("main")

    await page.screenshot({ path: `${EVIDENCE}/workspace-chip-existing.png`, fullPage: true })
    await page.keyboard.press("Escape")

    // Choosing an existing workspace and creating a new one stay distinct affordances:
    // the create path is the popover's footer action, never one of the rows above.
    await trigger.click()
    await expect(page.getByText("New cloud sandbox").filter({ visible: true }))
      .toHaveCount(1, { timeout: 20_000 })
    await page.keyboard.press("Escape")
  })

  test("selecting the existing cloud workspace keeps the draft on it", async ({ page }) => {
    await openCloudDraft(page)

    const trigger = await chip(page, "context-chip-worktree")
    await trigger.click()
    const row = page.locator('[data-slot="list-item"]').filter({ visible: true }).first()
    await expect(row).toBeVisible({ timeout: 20_000 })
    const key = await row.getAttribute("data-key")
    await row.click()

    // The trigger's own label settles on the chosen workspace rather than flipping back
    // to the create path.
    await expect(trigger.locator('[data-slot="context-chip-label"]'))
      .not.toHaveText("New cloud sandbox", { timeout: 20_000 })
    expect(key).toBeTruthy()

    await page.screenshot({ path: `${EVIDENCE}/workspace-chip-selected.png`, fullPage: true })
  })

  test("the branch chip lists refs and selecting one prepares a new cloud workspace", async ({ page }) => {
    const mock = await openCloudDraft(page)

    const trigger = await chip(page, "context-chip-branch")
    await expect(trigger.locator('[data-slot="context-chip-label"]')).toHaveText("main", { timeout: 20_000 })
    expect(await chipOptionKeys(page, "context-chip-branch")).toEqual(["main", "origin/feature/e2e"])

    await trigger.click()
    const feature = page.locator('[data-context-chip-picker="context-chip-branch"] [data-slot="list-item"][data-key="origin/feature/e2e"]')
    await expect(feature).toBeVisible({ timeout: 20_000 })
    await feature.click()
    await expect(trigger.locator('[data-slot="context-chip-label"]')).toHaveText("feature/e2e")

    const workspace = await chip(page, "context-chip-worktree")
    await expect(workspace.locator('[data-slot="context-chip-label"]')).toHaveText("New cloud sandbox")

    const prompt = "create from the selected hosted branch"
    const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
    await input.fill(prompt)
    // A new generic workspace has no bundled/fallback agent. The user must
    // choose one of the discovered connections before its model catalog has
    // an owner; this is the same contract as a user-supplied external server.
    await selectAgentConnection(page, "opencode")
    await ensureComposerModelSelected(page, { modelName: /^Big Pickle$/i, search: "Big Pickle" })
    await page.locator(SELECTORS.submitControl).last().click()
    await expect.poll(() => mock.requests.workspaceCreateBodies, { timeout: 20_000 }).toEqual([{
      projectId: `proj_cloud_${WORKSPACE_ID}`,
      gitBranch: "feature/e2e",
    }])
    await expect.poll(() => mock.requests.cloudPromptCount, { timeout: 20_000 }).toBe(1)
    await expectAssistantReplyVisible(page, `cloud ack 1: ${prompt}`)
    await page.screenshot({ path: `${EVIDENCE}/branch-chip-selected.png`, fullPage: true })
  })
})
