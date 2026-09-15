import { expect, test, type Page } from "@playwright/test"
import { ensureComposerModelSelected, expectAssistantReplyVisible, expectTurnCounts, SELECTORS } from "../helpers/turn-oracle"
import { installMockRuntime, type Harness, type MockRuntimeHandles } from "../helpers/mock-runtime"
import { decodeDraftDefaultRecord } from "../../src/features/session/harness/draft-defaults"

const DIR = "/tmp/e2e-core-harness-ownership-cloud"
const PROJECT_ID = "proj_core_harness_cloud"
const PROJECT_NAME = "core-harness-cloud-local"
const WORKSPACE_ID = "ws_core_harness_cloud"
const WORKSPACE_PROJECT_NAME = "core-harness-cloud-workspace"
const RELAY_ORIGIN = "https://relay.core-harness-ownership-cloud.test"

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

function workspaceRoute(sessionId?: string) {
  return sessionId ? `/w/${encodeURIComponent(WORKSPACE_ID)}/session/${sessionId}` : `/w/${encodeURIComponent(WORKSPACE_ID)}/session`
}

/** The signed lane reserves the session id before creating it, so the landing route
 * names the reservation, not a mock-chosen id. */
function reservedSessionId(mock: MockRuntimeHandles) {
  const sessionId = mock.requests.sessionReservations.at(-1)?.sessionId
  if (!sessionId) throw new Error("no session reservation reached the mock before the URL assertion")
  return sessionId
}

function sessionUrlPattern(sessionId: string) {
  return new RegExp(`(?:/s/${sessionId}|/w/[^/]+/session/${sessionId})$`)
}

async function switchDraftHarness(page: Page, optionName: RegExp, optionIndex: number) {
  await page.locator('[data-action="prompt-harness-model"]:visible').last().click()
  const picker = page.locator('[data-component="harness-model-picker"]')
  await picker.locator('[data-slot="harness-picker-section"]').first().click()
  await picker.getByRole("button", { name: optionName }).nth(optionIndex).click()
  await page.keyboard.press("Escape")
}

async function openProjectFromChip(page: Page, directory: string, projectName: string) {
  const chip = page.locator('[data-slot="context-chip-project"]').filter({ visible: true })
  await expect(chip).toHaveCount(1, { timeout: 20_000 })
  await chip.click()
  const row = page.locator(`[data-slot="list-item"][data-key="${directory}"]`).filter({ visible: true })
  await expect(row).toHaveCount(1, { timeout: 20_000 })
  await expect(row).toContainText(projectName)
  await row.click()
}

// Every draft-default record, key -> raw JSON. The key is per (server, workspace
// directory), so checks are key-level rather than over all values.
function readDraftDefaults(page: Page) {
  return page.evaluate(() =>
    Object.fromEntries(
      Object.entries(localStorage)
        .filter(([key]) => key.includes("draft-default"))
        .map(([key, value]) => [key, String(value)] as const),
    ),
  )
}

/** The harness a draft-default record opens with, decoded by the app's own reader
 * rather than a substring match on the raw JSON. */
function draftDefaultHarness(raw: string | undefined) {
  const selection = raw === undefined ? undefined : decodeDraftDefaultRecord(raw)?.lastHarness
  if (!selection) return undefined
  if (selection.kind === "connection") return selection.connectionId
  return { claude: "claude-sdk", codex: "codex-app-server", cursor: "cursor-sdk", pi: "pi", opencode: "opencode" }[selection.harnessId]
}

function visibleHarnessTrigger(page: Page, harness: Harness) {
  const selectionId = harness === "claude-sdk" ? "claude"
    : harness === "codex-app-server" ? "codex"
      : harness === "cursor-sdk" ? "cursor"
        : harness
  return page.locator(`[data-action="prompt-harness-model"][data-harness="${selectionId}"]:visible`)
}

// `:visible`: a same-pane cross-workspace navigation leaves the prior pane's composer
// mounted but hidden, so a bare count sees two controls.
async function expectOnlyHarnessModelControl(page: Page, modelName: string | RegExp) {
  await expect(page.locator('[data-action="prompt-harness-model"]:visible').last()).toContainText(modelName, { timeout: 20_000 })
  await expect(page.locator('[data-action="prompt-model"]:visible')).toHaveCount(0)
}

async function expectNoAgentSelected(page: Page) {
  const control = page.locator('[data-action="prompt-harness-model"]:visible').last()
  await expect(control).toBeVisible({ timeout: 20_000 })
  await expect(control).toContainText(/Select agent/i)
  await expect(visibleHarnessTrigger(page, "opencode")).toHaveCount(0)
  await expect(page.locator('[data-action="prompt-model"]:visible')).toHaveCount(0)
}

async function expectHarnessSwitchable(page: Page, harness: Harness) {
  const control = visibleHarnessTrigger(page, harness)
  await expect(control).toHaveCount(1, { timeout: 20_000 })
  await control.click()
  const section = page.locator('[data-component="harness-model-picker"] [data-slot="harness-picker-section"]').first()
  await expect(section).toBeEnabled()
  await page.keyboard.press("Escape")
}

test.describe("core harness ownership (cloud) @core", () => {
  // The exact labels are `HARNESS_CATALOG`'s for the native SDK modules
  // (data-harness claude/codex/cursor); generic connections use their configured labels.
  for (const harnessCase of [
    { harness: "claude-sdk" as Harness, option: /^Claude Code$/, optionIndex: 0, modelLabel: /Sonnet 4\.6|claude-sonnet-4-6/i, providerID: "claude", modelID: "claude-sonnet-4-6" },
    { harness: "codex-app-server" as Harness, option: /^Codex$/, optionIndex: 0, modelLabel: /GPT-5\.5|gpt-5\.5/i, providerID: "codex", modelID: "gpt-5.5" },
    { harness: "cursor-sdk" as Harness, option: /^Cursor$/, optionIndex: 0, modelLabel: /Cursor Auto|cursor-auto/i, providerID: "cursor", modelID: "cursor-auto" },
  ] as const) {
    test(`${harnessCase.harness} owns harness label, model, and payload through cloud draft, sends, and reload over the relay; locked after creation`, async ({ page }) => {
      const mock = await installMockRuntime(page, {
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
      await expectNoAgentSelected(page)

      await switchDraftHarness(page, harnessCase.option, harnessCase.optionIndex)
      await expect(visibleHarnessTrigger(page, harnessCase.harness)).toHaveCount(1, { timeout: 20_000 })
      await expectOnlyHarnessModelControl(page, harnessCase.modelLabel)

      const first = `core harness cloud ${harnessCase.harness} first turn`
      await input.click()
      await input.fill(first)
      await expect(input).toContainText(first, { timeout: 10_000 })
      await page.locator(SELECTORS.submitControl).last().click()

      await expect.poll(() => mock.requests.cloudPromptCount, { timeout: 15_000 }).toBe(1)
      expect(mock.requests.cloudSessionCreateCount).toBe(1)
      expect(mock.requests.cloudPromptBodies[0]).toMatchObject({ text: first, providerID: harnessCase.providerID, modelID: harnessCase.modelID })
      await expect(page).toHaveURL(sessionUrlPattern(reservedSessionId(mock)), { timeout: 20_000 })
      await expectAssistantReplyVisible(page, `cloud ack 1: ${first}`)
      await expectOnlyHarnessModelControl(page, harnessCase.modelLabel)

      await expectHarnessSwitchable(page, harnessCase.harness)

      await page.reload({ waitUntil: "domcontentloaded" })
      await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
      await expectOnlyHarnessModelControl(page, harnessCase.modelLabel)
      await expectHarnessSwitchable(page, harnessCase.harness)

      const second = `core harness cloud ${harnessCase.harness} resumed turn`
      const inputAfterReload = page.getByRole("textbox", { name: /Ask anything/i }).last()
      await inputAfterReload.click()
      await inputAfterReload.fill(second)
      await expect(inputAfterReload).toContainText(second, { timeout: 10_000 })
      await page.locator(SELECTORS.submitControl).last().click()
      await expect.poll(() => mock.requests.cloudPromptCount, { timeout: 15_000 }).toBe(2)
      expect(mock.requests.cloudPromptBodies[1]).toMatchObject({ text: second, providerID: harnessCase.providerID, modelID: harnessCase.modelID })
      await expectAssistantReplyVisible(page, `cloud ack 2: ${second}`)
      await expectTurnCounts(page, { user: 2, assistant: 2 })
    })
  }

  test("Pi loads native model options from the cloud workspace relay — behavior 2", async ({ page }) => {
    const mock = await installMockRuntime(page, {
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

    await switchDraftHarness(page, /^Pi$/, 0)
    await expect(visibleHarnessTrigger(page, "pi")).toHaveCount(1, { timeout: 20_000 })
    await expectOnlyHarnessModelControl(page, /Pi GPT-5\.5/i)
    await expect(page.locator('[title="Agent runtime unreachable after timeout"]')).toHaveCount(0)
    await expect(page.locator('[title="Connecting to agent runtime..."]')).toHaveCount(0)

    const first = "core harness cloud pi first turn"
    await input.click()
    await input.fill(first)
    await expect(input).toContainText(first, { timeout: 10_000 })
    await expect(page.locator(SELECTORS.submitControl).last()).toBeEnabled({ timeout: 5_000 })
    await page.locator(SELECTORS.submitControl).last().click()

    await expect.poll(() => mock.requests.cloudPromptCount, { timeout: 15_000 }).toBe(1)
    expect(mock.requests.cloudPromptBodies[0]).toMatchObject({ text: first, providerID: "pi", modelID: "openai/gpt-5.5" })
    await expectAssistantReplyVisible(page, `cloud ack 1: ${first}`)

    expect(mock.requests.cloudHarnessOptionsHarnesses).toContain("pi")
  })

  test("relay harness-config-options requests are scoped per harness — switching resolves each harness's own model, never a stale one", async ({ page }) => {
    const mock = await installMockRuntime(page, {
      dir: DIR,
      projectId: PROJECT_ID,
      projectName: PROJECT_NAME,
      cloud: { workspaceId: WORKSPACE_ID, relayOrigin: RELAY_ORIGIN, projectName: WORKSPACE_PROJECT_NAME },
    })
    await seedProjects(page)

    await page.goto(workspaceRoute())
    await page.waitForLoadState("domcontentloaded")
    await expect(page.getByRole("textbox", { name: /Ask anything/i }).last()).toBeVisible({ timeout: 20_000 })

    await switchDraftHarness(page, /^Claude Code$/, 0)
    await expectOnlyHarnessModelControl(page, /Sonnet 4\.6|claude-sonnet-4-6/i)
    await expect.poll(() => mock.requests.cloudHarnessOptionsHarnesses.includes("claude-sdk"), { timeout: 10_000 }).toBe(true)

    await switchDraftHarness(page, /^Codex$/, 0)
    await expectOnlyHarnessModelControl(page, /GPT-5\.5|gpt-5\.5/i)
    await expect.poll(() => mock.requests.cloudHarnessOptionsHarnesses.includes("codex-app-server"), { timeout: 10_000 }).toBe(true)

    // Every recorded request named its harness; none went out blank.
    expect(mock.requests.cloudHarnessOptionsHarnesses.every((h) => h.length > 0)).toBe(true)

    expect(mock.requests.harnessPostCount).toBe(0)
  })

  test("selecting a configurable harness on a cloud draft sends zero POSTs to the local harness-status endpoint", async ({ page }) => {
    const mock = await installMockRuntime(page, {
      dir: DIR,
      projectId: PROJECT_ID,
      projectName: PROJECT_NAME,
      cloud: { workspaceId: WORKSPACE_ID, relayOrigin: RELAY_ORIGIN, projectName: WORKSPACE_PROJECT_NAME },
    })
    await seedProjects(page)

    await page.goto(workspaceRoute())
    await page.waitForLoadState("domcontentloaded")
    await expect(page.getByRole("textbox", { name: /Ask anything/i }).last()).toBeVisible({ timeout: 20_000 })

    for (const [option, index] of [[/^Claude Code$/, 0], [/^Codex$/, 0], [/^Cursor$/, 0]] as const) {
      await switchDraftHarness(page, option, index)
    }
    await expect.poll(() => mock.requests.cloudHarnessOptionsCount, { timeout: 10_000 }).toBeGreaterThan(0)

    expect(mock.requests.harnessPostCount).toBe(0)
  })

  test("a cloud workspace draft starts on its own, unchosen state while the local draft's Claude choice is preserved per-directory", async ({ page }) => {
    await page.addInitScript(() => {
      const writes: string[] = []
      const pushState = window.history.pushState.bind(window.history)
      const replaceState = window.history.replaceState.bind(window.history)
      ;(window as Window & { __claxedoHistoryWrites?: string[] }).__claxedoHistoryWrites = writes
      window.history.pushState = (data, unused, url) => {
        if (url !== undefined && url !== null) writes.push(String(url))
        return pushState(data, unused, url)
      }
      window.history.replaceState = (data, unused, url) => {
        if (url !== undefined && url !== null) writes.push(String(url))
        return replaceState(data, unused, url)
      }
    })
    const mock = await installMockRuntime(page, {
      dir: DIR,
      projectId: PROJECT_ID,
      projectName: PROJECT_NAME,
      cloud: { workspaceId: WORKSPACE_ID, relayOrigin: RELAY_ORIGIN, projectName: WORKSPACE_PROJECT_NAME },
    })
    await seedProjects(page)

    await page.goto(`/w/${PROJECT_ID}/session`)
    await page.waitForLoadState("domcontentloaded")
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    const localInput = page.getByRole("textbox", { name: /Ask anything/i }).last()
    await expect(localInput).toBeVisible({ timeout: 20_000 })

    await switchDraftHarness(page, /^Claude Code$/, 0)
    await expectOnlyHarnessModelControl(page, /Sonnet 4\.6|claude-sonnet-4-6/i)

    // Snapshot while only the local directory has been visited, so every key present is
    // its own. The key embeds a directory hash and cannot be reconstructed, so it is
    // pinned by observation.
    await expect
      .poll(async () => Object.values(await readDraftDefaults(page)).filter((value) => draftDefaultHarness(value) === "claude-sdk").length, {
        timeout: 20_000,
      })
      .toBe(1)
    const localDraftDefaults = await readDraftDefaults(page)
    const localKeys = Object.keys(localDraftDefaults)
    expect(localKeys).toHaveLength(1)
    const localDraftDefaultKey = localKeys[0]

    // Same-pane client-side navigation to the cloud workspace, no reload.
    await openProjectFromChip(page, WORKSPACE_ID, WORKSPACE_PROJECT_NAME)

    await expect(page).toHaveURL(new RegExp(`/w/${WORKSPACE_ID}/session$`), { timeout: 20_000 })
    await expectNoAgentSelected(page)
    await expect(visibleHarnessTrigger(page, "claude-sdk")).toHaveCount(0)
    expect(mock.requests.cloudHarnessOptionsHarnesses.includes("claude-sdk")).toBe(false)

    // The local choice stays under its own key, byte-identical, and no other key
    // carries "claude-sdk".
    const afterNavigation = await readDraftDefaults(page)
    expect(afterNavigation[localDraftDefaultKey]).toBe(localDraftDefaults[localDraftDefaultKey])
    expect(draftDefaultHarness(afterNavigation[localDraftDefaultKey])).toBe("claude-sdk")
    expect(
      Object.entries(afterNavigation)
        .filter(([key]) => key !== localDraftDefaultKey)
        .filter(([, value]) => draftDefaultHarness(value) === "claude-sdk"),
    ).toEqual([])

    // Preserved means restored: going back must bring Claude and its model control back.
    await page.evaluate(() => {
      const writes = (window as Window & { __claxedoHistoryWrites?: string[] }).__claxedoHistoryWrites
      if (writes) writes.length = 0
    })
    await openProjectFromChip(page, DIR, PROJECT_NAME)
    // The route is keyed by the workspace id from the first history write; the physical
    // path never appears.
    await expect(page).toHaveURL(new RegExp(`/w/${mock.session.workspaceId}/session$`), { timeout: 20_000 })
    const historyWrites = await page.evaluate(
      () => (window as Window & { __claxedoHistoryWrites?: string[] }).__claxedoHistoryWrites ?? [],
    )
    expect(historyWrites).toEqual([`/w/${mock.session.workspaceId}/session`])
    expect(historyWrites.join("\n")).not.toContain(encodeURIComponent(DIR))
    await expect(visibleHarnessTrigger(page, "claude-sdk")).toHaveCount(1, { timeout: 20_000 })
    await expectOnlyHarnessModelControl(page, /Sonnet 4\.6|claude-sonnet-4-6/i)

    await openProjectFromChip(page, WORKSPACE_ID, WORKSPACE_PROJECT_NAME)
    await expect(page).toHaveURL(new RegExp(`/w/${WORKSPACE_ID}/session$`), { timeout: 20_000 })
    await expectNoAgentSelected(page)
    await expect(visibleHarnessTrigger(page, "claude-sdk")).toHaveCount(0)
    await switchDraftHarness(page, /^OpenCode$/, 0)
    await expect(visibleHarnessTrigger(page, "opencode")).toHaveCount(1, { timeout: 20_000 })

    // `filter({visible: true})`, not `.last()`: the prior directories' composers stay
    // mounted but hidden, and DOM order does not put the live one last.
    const cloudInput = page.getByRole("textbox", { name: /Ask anything/i }).filter({ visible: true })
    await expect(cloudInput).toHaveCount(1, { timeout: 20_000 })
    // OpenCode does not invent a catalog model default; pick one before sending.
    const text = "core harness cloud own-default turn"
    await cloudInput.click()
    await cloudInput.fill(text)
    await expect(cloudInput).toContainText(text, { timeout: 10_000 })
    await ensureComposerModelSelected(page, { modelName: /^Big Pickle$/i, search: "Big Pickle" })
    await page.locator(`${SELECTORS.submitControl}:visible`).last().click()

    await expect.poll(() => mock.requests.cloudPromptCount, { timeout: 15_000 }).toBe(1)
    expect(mock.requests.cloudPromptBodies[0]).toMatchObject({ text, providerID: "opencode", modelID: "big-pickle-1" })
    await expectAssistantReplyVisible(page, `cloud ack 1: ${text}`)
  })
})
