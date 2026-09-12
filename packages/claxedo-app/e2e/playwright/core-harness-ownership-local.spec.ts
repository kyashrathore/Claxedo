/**
 * Local session harness ownership: a session runs on one of several agent harnesses
 * (Claude, Codex and Cursor each via an ACP connection or a native SDK, Pi via its
 * native RPC process, or plain OpenCode). Whichever harness is selected owns the
 * session's model, agent, and submit payload end to end — a prompt is never silently
 * routed through plain OpenCode, and there is never more than one model picker on
 * screen.
 *
 * The live harness selection is transient client state (`harnessStore`) keyed by a
 * pane-preference scope; nothing is persisted per scope. What a NEW draft remembers is
 * one `session.draft-default.v1` record per (server, workspaceKey), holding
 * `lastHarness` plus a per-harness `{model, labels}` slot — so picking Codex and then
 * Claude does not overwrite the Codex model, and a second workspace reads a different
 * record and falls back to `opencode` on its own. That per-workspace keying, not any
 * reset hook, is what isolates two workspaces' drafts; nothing in `src/` resets a draft
 * harness on navigation.
 *
 * A draft lands on a harness two ways: (a) the user picks one from the picker, which
 * POSTs `/api/claxedo/agent-config/harness`; (b) `AgentHarnessSelector` hydrates on
 * mount, GETting the same endpoint and silently applying whatever harness the backend
 * reports as current, with zero user interaction. The matrix cases below exercise (b)
 * — the mock is seeded with the harness, so the draft renders it from the first paint
 * and no click is possible; behavior 1's test exercises (a).
 *
 * Readiness is a 4-member union, not a boolean, resolved in this precedence order: an
 * `error` status or message => "error"; else a non-`opencode` harness reporting
 * `ready:false` => "polling" for a startup/in-flight probe but "error" when the frame
 * is a settled completed switch response; else `degraded`/`unavailable` health =>
 * "degraded"; else "ready". `opencode` is never "polling" and never "degraded". So a
 * backend still starting up (`status:"applying"`) renders the pulsing "Connecting"
 * pill, not the red "Unavailable" notice row. "Polling" is not a dead end: hydration is
 * one-shot (a per-scope "seen" stamp), so `watchHarnessReprobe` clears that stamp and
 * re-hydrates on an interval until the harness settles, or gives up after a hard cap
 * and transitions to "Unavailable" — bounded, never silent.
 *
 * A `stale:true` model-options response carrying no models is applied WITHOUT touching
 * the selected model, and schedules a retry after 1000ms, up to 5 tries.
 *
 * ANATOMY —
 *   `[data-action="prompt-harness-model"]` — the one harness/model/effort control, for
 *     every harness. Its text is the resolved model name, "Loading models", "No Pi
 *     models available", or "Select model". It names a model or says there is none; it
 *     never reports an error — that is the notice row's job.
 *   `[data-component="composer-notice"]` — the composer's ONE error surface, a row
 *     that peeks above the project/worktree context row, carrying `data-notice`,
 *     `data-tone`, the runtime's own detail text, and its own
 *     `[data-action="composer-notice-action"]` Retry.
 *   `[title="Agent runtime unreachable after timeout"]` (readiness "error") and
 *     `[title="Connecting to agent runtime..."]` (readiness "polling") — both titles
 *     are kept byte-exact for these specs.
 *   `[role="textbox"]` composer editor — UNCONDITIONALLY `contenteditable="true"` and
 *     never `aria-disabled`, polling or not: the composer gates the SUBMIT, not the
 *     typing, because a dead-looking box teaches nothing. The editor is therefore not a
 *     readiness signal here; the submit control is.
 *   `[data-action="prompt-submit"]` — `data-icon="stop"` only while the turn is working
 *     AND the session's `abort` capability is true. With `abort:false`, a busy turn's
 *     control is disabled whenever the composer is blank: it can neither stop the turn
 *     nor send a new one.
 *
 * HARNESS LABELS — an ACP harness shows under its connection id (`claude-acp`,
 *   `codex-acp`, `cursor-acp`); the native SDK harnesses show under the product label
 *   ("Claude", "Codex", "Cursor"), and Pi and OpenCode under "Pi"/"OpenCode". The
 *   matrix cases pin the variant by the submit payload's `providerID` as well as the
 *   picker label, so an ACP/native mix-up cannot pass on label text alone.
 */
import { sessionListRoute } from "../helpers/contracts/session-list"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { installMockRuntime, type Harness } from "../helpers/mock-runtime"
import { ensureComposerModelSelected, expectAssistantReplyVisible, expectTurnCounts, expectNoDuplicateRows, SELECTORS } from "../helpers/turn-oracle"

const DIR = "/tmp/e2e-core-harness-ownership-local"

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

async function seedOneProject(page: Page, dir: string) {
  await page.addInitScript((d: string) => {
    ;(window as typeof window & { __CLAXEDO__?: { serverUrl?: string; activeDirectory?: string } }).__CLAXEDO__ = {
      serverUrl: window.location.origin,
      activeDirectory: d,
    }
    if (sessionStorage.getItem("core-harness-seeded")) return
    sessionStorage.setItem("core-harness-seeded", "1")
    localStorage.clear()
    localStorage.setItem(
      "claxedo.global.dat:server",
      JSON.stringify({
        list: [],
        projects: { local: [{ worktree: d, expanded: true }] },
        lastProject: {},
        workspaceServer: {},
        closedProjects: {},
      }),
    )
  }, dir)
}

async function openDraftPrompt(page: Page, dir: string): Promise<Locator> {
  await page.goto(`/${slug(dir)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await expect(input).toBeVisible({ timeout: 20_000 })
  await expect(input).toHaveAttribute("contenteditable", "true")
  return input
}

async function composePrompt(page: Page, input: Locator, text: string) {
  await input.click()
  await input.fill(text)
  if (!((await input.textContent()) ?? "").includes(text)) {
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A")
    await page.keyboard.type(text)
  }
  await expect(input).toContainText(text, { timeout: 10_000 })
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

async function expectOnlyHarnessModelControl(page: Page, modelName: string | RegExp) {
  await expect(page.locator('[data-action="prompt-harness-model"]').last()).toContainText(modelName, { timeout: 20_000 })
  await expect(page.locator('[data-action="prompt-model"]')).toHaveCount(0)
}

/**
 * A mock seeded with a non-`opencode` harness is adopted by the draft on mount:
 * `AgentHarnessSelector` hydrates from `/api/claxedo/agent-config/harness` and applies
 * the harness the backend reports, whatever the client-side default was. No user click
 * is needed or possible — by first paint the picker already reads the target harness's
 * label, not "OpenCode". This helper waits for that.
 */
async function expectHarnessAutoHydrated(page: Page, optionLabel: RegExp) {
  const control = page.locator('[data-action="prompt-harness-model"]:visible').last()
  await expect(control).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('[data-action="prompt-model"]')).toHaveCount(0)
  if (await control.isDisabled()) return
  await control.click()
  const section = page.locator('[data-component="harness-model-picker"] [data-slot="harness-picker-section"]').first()
  await expect(section.locator("span").last()).toHaveText(optionLabel)
  await page.keyboard.press("Escape")
}

async function expectHarnessSwitchable(page: Page, optionLabel: RegExp) {
  const control = page.locator('[data-action="prompt-harness-model"]:visible').last()
  if (await control.isDisabled()) return
  await control.click()
  const section = page.locator('[data-component="harness-model-picker"] [data-slot="harness-picker-section"]').first()
  await expect(section.locator("span").last()).toHaveText(optionLabel)
  await expect(section).toBeEnabled()
  await page.keyboard.press("Escape")
}

async function expectOnlyOpenCodeModelControl(page: Page) {
  await expect(page.locator('[data-action="prompt-harness-model"]')).toHaveCount(1)
  await expect(page.locator('[data-action="prompt-harness-model"]')).toHaveAttribute("data-harness", "opencode")
  await expect(page.locator('[data-action="prompt-model"]')).toHaveCount(0)
}

test.describe("core harness ownership (local) @core", () => {
  // The harness matrix drives several sends + a reload per scenario, and this shared
  // dev server runs under heavy concurrent load from other e2e sessions — give every
  // test in this file headroom above the default so a slow (not stuck) navigation
  // doesn't fail the whole scenario. This is a per-file timeout bump, not a weakened
  // assertion — every wait inside the tests is still a deterministic poll/expect.
  test.beforeEach(async () => {
    const testInfo = test.info()
    testInfo.setTimeout(120_000)
  })

  test("the unified picker owns OpenCode and harness model selection without duplicate controls", async ({
    page,
  }) => {
    await seedOneProject(page, DIR)
    await installMockRuntime(page, { dir: DIR, sessionId: "ses_core_harness_exclusive", harness: "opencode" })

    await openDraftPrompt(page, DIR)
    await expectOnlyOpenCodeModelControl(page)

    await switchDraftHarness(page, /^Claude$/, 0)
    await expectOnlyHarnessModelControl(page, /Sonnet 4\.6|claude-sonnet-4-6/i)

    await expect(page.locator('[data-action="prompt-model"]')).toHaveCount(0)
    await expect(page.locator('[data-action="prompt-harness-model"]')).toHaveCount(1)
  })

  for (const harnessCase of [
    {
      harness: "acp:claude" as Harness,
      label: "Claude ACP",
      option: /^claude-acp$/,
      optionIndex: 0,
      modelLabel: /Sonnet 4\.6|claude-sonnet-4-6/i,
      providerID: "claude-acp",
      modelID: "claude-sonnet-4-6",
    },
    {
      harness: "claude-sdk" as Harness,
      label: "Claude SDK",
      option: /^Claude$/,
      optionIndex: 0,
      modelLabel: /Sonnet 4\.6|claude-sonnet-4-6/i,
      providerID: "claude",
      modelID: "claude-sonnet-4-6",
    },
    {
      harness: "acp:codex" as Harness,
      label: "Codex ACP",
      option: /^codex-acp$/,
      optionIndex: 0,
      modelLabel: /GPT-5\.2 Codex|gpt-5\.2-codex/i,
      providerID: "codex-acp",
      modelID: "gpt-5.2-codex",
    },
    {
      harness: "codex-app-server" as Harness,
      label: "Codex Native SDK",
      option: /^Codex$/,
      optionIndex: 0,
      modelLabel: /GPT-5\.5|gpt-5\.5/i,
      providerID: "codex",
      modelID: "gpt-5.5",
    },
    {
      harness: "acp:cursor" as Harness,
      label: "Cursor ACP",
      option: /^cursor-acp$/,
      optionIndex: 0,
      modelLabel: /Cursor Auto|cursor-auto/i,
      providerID: "cursor-acp",
      modelID: "cursor-auto",
    },
    {
      harness: "cursor-sdk" as Harness,
      label: "Cursor SDK",
      option: /^Cursor$/,
      optionIndex: 0,
      modelLabel: /Cursor Auto|cursor-auto/i,
      providerID: "cursor",
      modelID: "cursor-auto",
    },
  ] as const) {
    test(`${harnessCase.label} owns harness label, model, and payload through draft, sends, and reload; locked after creation`, async ({
      page,
    }) => {
      const sessionId = `ses_core_harness_${harnessCase.harness.replace(/[^a-z0-9]/g, "_")}`
      const mock = await installMockRuntime(page, { dir: DIR, sessionId, harness: harnessCase.harness })

      await seedOneProject(page, DIR)
      const input = await openDraftPrompt(page, DIR)

      await expectHarnessAutoHydrated(page, harnessCase.option)
      await expectOnlyHarnessModelControl(page, harnessCase.modelLabel)

      await expect(page.locator('[data-action="prompt-harness-model"]:visible').last()).toBeEnabled()

      const first = `core harness ${harnessCase.harness} first turn`
      await composePrompt(page, input, first)
      await page.locator(SELECTORS.submitControl).last().click()

      await expect.poll(() => mock.requests.promptCount, { timeout: 15_000 }).toBe(1)
      expect(mock.requests.createSessionCount).toBe(1)
      expect(mock.requests.harnessSessionCreateCount).toBe(1)
      expect(mock.requests.promptBodies[0]).toMatchObject({
        text: first,
        agent: "build",
        providerID: harnessCase.providerID,
        modelID: harnessCase.modelID,
      })
      await expect(page).toHaveURL(sessionUrlPattern(sessionId), { timeout: 20_000 })
      await expectAssistantReplyVisible(page, `ack 1: ${first}`)
      await expectOnlyHarnessModelControl(page, harnessCase.modelLabel)

      await expectHarnessSwitchable(page, harnessCase.option)

      const second = `core harness ${harnessCase.harness} second turn`
      await composePrompt(page, page.getByRole("textbox", { name: /Ask anything/i }).last(), second)
      await page.locator(SELECTORS.submitControl).last().click()
      await expect.poll(() => mock.requests.promptCount, { timeout: 15_000 }).toBe(2)
      expect(mock.requests.promptBodies[1]).toMatchObject({
        text: second,
        agent: "build",
        providerID: harnessCase.providerID,
        modelID: harnessCase.modelID,
      })
      await expectAssistantReplyVisible(page, `ack 2: ${second}`)
      await expectTurnCounts(page, { user: 2, assistant: 2 })
      await expectNoDuplicateRows(page)

      await page.reload({ waitUntil: "domcontentloaded" })
      await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
      await expectOnlyHarnessModelControl(page, harnessCase.modelLabel)
      await expectHarnessSwitchable(page, harnessCase.option)

      const third = `core harness ${harnessCase.harness} resumed turn`
      await composePrompt(page, page.getByRole("textbox", { name: /Ask anything/i }).last(), third)
      await page.locator(SELECTORS.submitControl).last().click()
      await expect.poll(() => mock.requests.promptCount, { timeout: 15_000 }).toBe(3)
      expect(mock.requests.promptBodies[2]).toMatchObject({
        text: third,
        agent: "build",
        providerID: harnessCase.providerID,
        modelID: harnessCase.modelID,
      })
      await expectAssistantReplyVisible(page, `ack 3: ${third}`)
    })
  }

  /**
   * The native-SDK catalog shape: the first row is the harness's own `default` sentinel
   * and the option's `currentValue`, and every row carries a `description` the picker
   * renders under the name, so a `^Sonnet$` filter over the whole row text matches nothing.
   */
  const REAL_CLAUDE_SDK_MODELS = [
    { id: "default", name: "Default (recommended)", description: "Opus 5 with 1M context \u00b7 Best for everyday, complex tasks" },
    { id: "opus[1m]", name: "Opus (1M context)", description: "Opus 5 with 1M context \u00b7 Best for everyday, complex tasks" },
    { id: "claude-fable-5-1[1m]", name: "Fable", description: "Fable 5.1 \u00b7 Most capable for your hardest and longest-running tasks" },
    { id: "sonnet", name: "Sonnet", description: "Sonnet 5 \u00b7 Efficient for routine tasks" },
    { id: "haiku", name: "Haiku", description: "Haiku 4.5 \u00b7 Fastest for quick answers" },
  ]

  test("a native-SDK harness shows the model it resolved until the user picks one, and the pick survives a reload", async ({
    page,
  }) => {
    await installMockRuntime(page, {
      dir: DIR,
      sessionId: "ses_core_harness_claude_resolved_default",
      harness: "claude-sdk",
      harnessModels: { "claude-sdk": REAL_CLAUDE_SDK_MODELS },
    })
    await seedOneProject(page, DIR)
    await openDraftPrompt(page, DIR)

    const control = page.locator('[data-action="prompt-harness-model"]:visible').last()
    // A draft with no choice shows the harness-resolved model.
    await expect(control).toHaveAttribute("data-model", "default", { timeout: 20_000 })
    await expect(control).toContainText(/Default \(recommended\)/i)

    // An explicit pick is authoritative for this (workspace, harness).
    await control.click()
    const picker = page.locator('[data-component="harness-model-picker"]')
    const search = page.getByRole("textbox", { name: /Search models/i }).last()
    await expect(search).toBeVisible({ timeout: 10_000 })
    await search.fill("Sonnet")
    await picker
      .locator('[data-slot="list-item"]')
      .filter({ has: page.locator('[data-slot="list-item-name"]', { hasText: /^Sonnet$/ }) })
      .first()
      .click()
    await expect(control).toHaveAttribute("data-model", "sonnet", { timeout: 10_000 })
    await expect(control).toContainText(/Sonnet/i)

    // It survives a reload of the same (server, workspace, harness) scope.
    await page.reload()
    await page.waitForLoadState("domcontentloaded")
    const reloaded = page.locator('[data-action="prompt-harness-model"]:visible').last()
    await expect(reloaded).toHaveAttribute("data-harness", "claude", { timeout: 20_000 })
    await expect(
      reloaded,
      "the harness-resolved default overwrote the model the user explicitly chose",
    ).toHaveAttribute("data-model", "sonnet", { timeout: 20_000 })
  })

  test("switching to a native-SDK harness with a slow model probe still lets the pick beat the resolved default", async ({
    page,
  }) => {
    await installMockRuntime(page, {
      dir: DIR,
      sessionId: "ses_core_harness_claude_slow_probe",
      harness: "opencode",
      harnessModels: { "claude-sdk": REAL_CLAUDE_SDK_MODELS },
    })
    // The real model probe takes seconds and the switcher does not await it; the delay
    // orders "resolved default" before "user picked". Registered after the mock so it
    // wins the route and falls through to the mock's answer.
    await page.route("**/api/claxedo/agent-config/harness/options**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      return route.fallback()
    })
    await seedOneProject(page, DIR)
    await openDraftPrompt(page, DIR)
    await expectOnlyOpenCodeModelControl(page)

    // Exactly one "Claude" row here: the ACP group is built from
    // operator-configured ACP connections and this mock deployment configures none,
    // so the only Claude on offer is the native SDK.
    await switchDraftHarness(page, /^Claude$/, 0)
    const control = page.locator('[data-action="prompt-harness-model"]:visible').last()
    await expect(control).toHaveAttribute("data-harness", "claude", { timeout: 20_000 })
    await expect(control).toHaveAttribute("data-model", "default", { timeout: 20_000 })

    await control.click()
    const picker = page.locator('[data-component="harness-model-picker"]')
    const search = page.getByRole("textbox", { name: /Search models/i }).last()
    await expect(search).toBeVisible({ timeout: 10_000 })
    await search.fill("Sonnet")
    await picker
      .locator('[data-slot="list-item"]')
      .filter({ has: page.locator('[data-slot="list-item-name"]', { hasText: /^Sonnet$/ }) })
      .first()
      .click()
    await expect(
      control,
      "the user's model pick did not stick over the harness-resolved default",
    ).toHaveAttribute("data-model", "sonnet", { timeout: 10_000 })
  })

  test("a newly-created busy Claude native session keeps its harness and model during the first turn", async ({
    page,
  }) => {
    const sessionId = "ses_core_harness_claude_first_turn"
    const mock = await installMockRuntime(page, {
      dir: DIR,
      sessionId,
      harness: "claude-sdk",
      harnessModels: {
        "claude-sdk": [{ id: "default", name: "Default (recommended)" }],
      },
      delayedIdleMs: 3_000,
    })
    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)
    const control = page.locator('[data-action="prompt-harness-model"]:visible').last()
    await expect(control).toContainText(/Default \(recommended\)|default/i, { timeout: 20_000 })

    const text = "core Claude native first turn"
    await composePrompt(page, input, text)
    await page.locator(SELECTORS.submitControl).last().click()
    await expect.poll(() => mock.requests.promptCount, { timeout: 15_000 }).toBe(1)
    await expect(page).toHaveURL(sessionUrlPattern(sessionId), { timeout: 20_000 })
    await expect(page.locator(SELECTORS.submitControl).last()).toHaveAttribute("aria-label", /stop/i, {
      timeout: 10_000,
    })

    await expect(control, "draft-to-session handoff cleared the native Claude model while the turn was busy").toContainText(
      /Default \(recommended\)|default/i,
      { timeout: 1_000 },
    )
    await expect(control).not.toContainText(/Loading models|Select model|^$/)
    await control.click()
    await expect(page.locator('[data-component="harness-model-picker"]')).toContainText(/Harness\s*Claude/i)
  })

  test("a prefetched rail switch restores an existing native harness and model after the network-quiet window", async ({
    page,
  }) => {
    const sessionId = "ses_core_harness_fast_switch"
    const first = "core native harness fast switch"
    await installMockRuntime(page, {
      dir: DIR,
      sessionId,
      harness: "codex-app-server",
      existingSession: { prompt: first, reply: `ack 1: ${first}` },
    })
    await seedOneProject(page, DIR)
    await page.route(sessionListRoute, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        view: {
          scope: "workspace",
          groupBy: "none",
          sort: new URL(route.request().url()).searchParams.get("sort") ?? "updated_desc",
          limit: 5,
        },
        items: [{
          type: "session",
          sessionRef: sessionId,
          sessionId,
          title: first,
          directory: DIR,
          projectId: "proj_mock_runtime",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          tags: [],
          attachments: [],
        }],
      }),
    }))
    // A rail click from home starts the fast-switch network-quiet window; direct
    // session URLs and reloads never do.
    await page.goto("/")
    await page.waitForLoadState("domcontentloaded")
    const row = page.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${sessionId}"]`).first()
    await expect(row).toBeVisible({ timeout: 20_000 })
    // Write the quiet window in the same browser task as the click, independent of
    // prefetch timing, so the composer mounts while it is active.
    await row.evaluate((element, id) => {
      ;(element.querySelector("button"))?.click()
      const now = Date.now()
      ;(window as typeof window & {
        __claxedoFastSessionSwitch?: { sessionId: string; until: number; networkQuietUntil?: number }
      }).__claxedoFastSessionSwitch = {
        sessionId: id,
        until: now + 250,
        networkQuietUntil: now + 2_000,
      }
    }, sessionId)

    const quietUntil = await page.evaluate(() => (
      window as typeof window & { __claxedoFastSessionSwitch?: { networkQuietUntil?: number } }
    ).__claxedoFastSessionSwitch?.networkQuietUntil)
    expect(quietUntil, "rail click did not exercise the prefetched network-quiet path").toBeGreaterThan(Date.now())

    await expect(page).toHaveURL(sessionUrlPattern(sessionId), { timeout: 20_000 })
    const restoredControl = page.locator('[data-action="prompt-harness-model"]').last()
    await expect(restoredControl).toContainText(
      /GPT-5\.5|gpt-5\.5/i,
      { timeout: 500 },
    )
    await expect(restoredControl).toHaveAttribute("data-harness", "codex")
    await expect(restoredControl).toHaveAttribute("data-model", "gpt-5.5")
    await expect(restoredControl).toHaveAttribute("data-ready-for-submit", "true")
    await expect(page.locator('[data-action="prompt-model"]')).toHaveCount(0)
  })

  test("a busy Claude native session keeps its harness and model after a partial session.updated frame", async ({
    page,
  }) => {
    const sessionId = "ses_core_harness_claude_updated"
    const workspaceId = "ws_core_harness_claude_updated"
    const mock = await installMockRuntime(page, {
      dir: DIR,
      sessionId,
      harness: "claude-sdk",
      harnessModels: {
        "claude-sdk": [{ id: "default", name: "Default (recommended)" }],
      },
      existingSession: { prompt: "existing Claude prompt", reply: "existing Claude reply" },
      workspaces: {
        [DIR]: { workspaceId, kind: "local", directory: DIR, available: true },
      },
    })

    await seedOneProject(page, DIR)
    await page.goto(`/${slug(DIR)}/session/${sessionId}`)
    await page.waitForLoadState("domcontentloaded")
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    const control = page.locator('[data-action="prompt-harness-model"]:visible').last()
    await expect(control).toContainText(/Default \(recommended\)|default/i, { timeout: 20_000 })

    mock.setSessionStatus(sessionId, { type: "busy" })
    mock.emit({ type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } })
    await expect(page.locator('[data-action="prompt-submit"]:visible').last()).toHaveAttribute("aria-label", /stop/i, {
      timeout: 10_000,
    })

    const now = Date.now()
    mock.emitFlat({
      type: "session.updated",
      directory: DIR,
      workspaceId,
      properties: {
        sessionID: sessionId,
        info: {
          id: sessionId,
          slug: sessionId,
          projectID: "proj_mock_runtime",
          directory: DIR,
          title: "Updated Claude title",
          version: "local",
          time: { created: now - 1_000, updated: now },
        },
      },
    })

    await page.waitForTimeout(500)
    await expect(control).toContainText(/Default \(recommended\)|default/i)
    await expect(control).not.toContainText(/Select model/i)
  })

  test("Pi loads machine model options and owns the native prompt payload — behavior 4", async ({
    page,
  }) => {
    const sessionId = "ses_core_harness_pi"
    const mock = await installMockRuntime(page, { dir: DIR, sessionId, harness: "opencode" })

    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)
    await expectOnlyHarnessModelControl(page, /Big Pickle|big-pickle/i)

    await switchDraftHarness(page, /^Pi$/, 0)
    await expect(page.locator('[data-action="prompt-harness-model"][data-harness="pi"]').last()).toBeVisible({ timeout: 20_000 })
    await expectOnlyHarnessModelControl(page, /Pi GPT-5\.5/i)
    await expect.poll(() => mock.requests.harnessOptionsHarnesses.includes("pi")).toBe(true)
    await expect(page.locator('[title="Agent runtime unreachable after timeout"]')).toHaveCount(0)
    await expect(page.locator('[title="Connecting to agent runtime..."]')).toHaveCount(0)

    const first = "core harness pi first turn"
    await composePrompt(page, input, first)
    await expect(page.locator(SELECTORS.submitControl).last()).toBeEnabled({ timeout: 5_000 })
    await page.locator(SELECTORS.submitControl).last().click()

    await expect.poll(() => mock.requests.promptCount, { timeout: 15_000 }).toBe(1)
    expect(mock.requests.promptBodies[0]).toMatchObject({
      text: first,
      providerID: "pi",
      modelID: "openai/gpt-5.5",
    })
    await expect(page).toHaveURL(sessionUrlPattern(sessionId), { timeout: 20_000 })
    await expectAssistantReplyVisible(page, `ack 1: ${first}`)

    await page.goto(`/${slug(DIR)}/session`)
    await page.waitForLoadState("domcontentloaded")
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole("textbox", { name: /Ask anything/i }).last()).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-action="prompt-harness-model"][data-harness="pi"]').last()).toBeVisible({ timeout: 20_000 })
    await expectOnlyHarnessModelControl(page, /Pi GPT-5\.5/i)

    expect(mock.requests.harnessOptionsHarnesses).toContain("pi")
  })

  test(
    "unavailable/auth-error harness shows one notice row, blocks submit, sends zero requests, never falls back to OpenCode",
    async ({ page }) => {
      // `hydrate()` seeds the store with a placeholder `{harness:"opencode"}` before
      // it fetches status, and that placeholder is the only harness a fresh scope with
      // no saved preference can carry. A failed status must therefore still apply over
      // it — a guard that treats the seed as a confirmed selection drops the failure
      // and leaves the draft on OpenCode, where nothing ever surfaces the error.
      const errorMessage = "claude binary not found"
      const mock = await installMockRuntime(page, {
        dir: DIR,
        sessionId: "ses_core_harness_unavailable",
        harness: "acp:claude",
        harnessReadiness: "error",
        harnessReadinessError: errorMessage,
      })

      await seedOneProject(page, DIR)
      const input = await openDraftPrompt(page, DIR)

      await expectHarnessAutoHydrated(page, /^claude-acp$/)

      await expect(page.locator('[title="Agent runtime unreachable after timeout"]')).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('[title="Connecting to agent runtime..."]')).toHaveCount(0)

      const notice = page.locator("[data-component='composer-notice']")
      await expect(notice).toHaveCount(1)
      await expect(notice).toHaveAttribute("data-notice", "runtime-unavailable")
      await expect(notice).toHaveAttribute("data-tone", "critical")
      // The reason is readable without hovering anything.
      await expect(notice).toContainText("claude-acp runtime is unavailable")
      await expect(notice).toContainText(errorMessage)
      await expect(notice.locator("[data-action='composer-notice-action']")).toBeVisible()
      // The model control names a model or says there is none; the error text belongs
      // to the notice row alone.
      await expect(page.locator('[data-action="prompt-harness-model"]')).not.toContainText("Unavailable")

      // `harness-error` is an ACTIONABLE submit-block reason: the control stays
      // clickable but dimmed and explains its refusal on intent, rather than going
      // silently dead. The gate that stops the send is `submitBlocked` inside the
      // submit handler, not the button's `disabled` attribute.
      await composePrompt(page, input, "core harness unavailable attempt")
      const submit = page.locator(SELECTORS.submitControl).last()
      await expect(submit).toBeEnabled()
      await expect(submit).toHaveClass(/opacity-50/)
      await expect(submit).toHaveAttribute("aria-label", "The agent isn't running")
      await submit.click()

      // Never silently falls back to plain OpenCode.
      await expect(page.locator('[data-action="prompt-model"]')).toHaveCount(0)
      await expect(page.locator('[data-action="prompt-harness-model"]')).toHaveCount(1)
      await expect(page.locator('[data-action="prompt-harness-model"][data-harness="opencode"]')).toHaveCount(0)

      expect(mock.requests.promptCount).toBe(0)
      expect(mock.requests.createSessionCount).toBe(0)
    },
  )

  test(
    "Connecting keeps the unified picker inspectable while submit stays disabled and sends zero requests",
    async ({ page }) => {
      const mock = await installMockRuntime(page, {
        dir: DIR,
        sessionId: "ses_core_harness_polling",
        harness: "acp:claude",
        harnessReadiness: "polling",
        // Stays in the "applying" window for the whole test; it never flips to ready.
        harnessPollingTurns: 1000,
      })

      await seedOneProject(page, DIR)
      await page.goto(`/${slug(DIR)}/session`)
      await page.waitForLoadState("domcontentloaded")
      await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
      const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
      await expect(input).toBeVisible({ timeout: 20_000 })

      await expectHarnessAutoHydrated(page, /^claude-acp$/)

      await expect(page.locator('[title="Connecting to agent runtime..."]')).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('[title="Agent runtime unreachable after timeout"]')).toHaveCount(0)

      await expect(input).toHaveAttribute("contenteditable", "true")
      await expect(input).not.toHaveAttribute("aria-disabled")
      await expect(page.locator('[data-action="prompt-harness-model"]:visible').last()).toBeEnabled()
      await expect(page.locator(SELECTORS.submitControl).last()).toBeDisabled()

      // Never silently falls back to plain OpenCode, and no requests are sent.
      await expect(page.locator('[data-action="prompt-harness-model"][data-harness="opencode"]')).toHaveCount(0)
      expect(mock.requests.promptCount).toBe(0)
      expect(mock.requests.createSessionCount).toBe(0)
    },
  )

  test(
    "a slow harness settles under the bounded re-probe loop: Connecting clears, readiness becomes ready, and submit unlocks",
    async ({ page }) => {
      // `harnessGetPollSettleAfter` flips the mock's harness-status GET to ready after N
      // probes; the previous test omits it and stays polling.
      const mock = await installMockRuntime(page, {
        dir: DIR,
        sessionId: "ses_core_harness_polling_settles",
        harness: "acp:claude",
        harnessReadiness: "polling",
        // No switch POST in this flow; the GET re-probe loop is the only settle path.
        harnessPollingTurns: 1000,
        harnessGetPollSettleAfter: 3,
      })

      await seedOneProject(page, DIR)

      // Navigate inline rather than through `openDraftPrompt` so the polling contract
      // is asserted with no intermediate ready-harness assumption.
      await page.goto(`/${slug(DIR)}/session`)
      await page.waitForLoadState("domcontentloaded")
      await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
      const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
      await expect(input).toBeVisible({ timeout: 20_000 })

      await expectHarnessAutoHydrated(page, /^claude-acp$/)
      const harnessTrigger = page.locator('[data-action="prompt-harness-model"]:visible').last()

      await expect(page.locator('[title="Connecting to agent runtime..."]')).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('[title="Agent runtime unreachable after timeout"]')).toHaveCount(0)
      await expect(input).toHaveAttribute("contenteditable", "true")
      await expect(harnessTrigger).toBeEnabled()
      await expect(harnessTrigger).toHaveAttribute("data-readiness", "polling")

      // The pill clears with no user action and no reload: the bounded re-probe loop
      // is what settles the harness.
      await expect(page.locator('[title="Connecting to agent runtime..."]')).toHaveCount(0, { timeout: 30_000 })
      await expect(page.locator('[title="Agent runtime unreachable after timeout"]')).toHaveCount(0)
      await expect(harnessTrigger).toBeEnabled({ timeout: 10_000 })
      await expect(harnessTrigger).toHaveAttribute("data-readiness", "ready")

      await expectOnlyHarnessModelControl(page, /Sonnet 4\.6|claude-sonnet-4-6/i)
      await composePrompt(page, input, "core harness polling settled turn")
      await expect(page.locator(SELECTORS.submitControl).last()).toBeEnabled({ timeout: 10_000 })

      await page.locator(SELECTORS.submitControl).last().click()
      await expect.poll(() => mock.requests.promptCount, { timeout: 15_000 }).toBe(1)
      expect(mock.requests.promptBodies[0]).toMatchObject({
        text: "core harness polling settled turn",
        providerID: "claude-acp",
        modelID: "claude-sonnet-4-6",
      })
    },
  )

  test("session busy with abort capability false disables submit while the composer is blank", async ({
    page,
  }) => {
    const sessionId = "ses_core_harness_no_abort"
    const mock = await installMockRuntime(page, {
      dir: DIR,
      sessionId,
      harness: "opencode",
      timingsMs: { idle: 3_000 },
    })
    // After installMockRuntime so this route wins: same session, abort capability off.
    await page.route("**/session/*/capabilities**", (route) => {
      const type = route.request().resourceType()
      if (type !== "fetch" && type !== "xhr") return route.continue()
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          transport: "runtime",
          abort: false,
          reconnect: true,
          replay: true,
          permissions: true,
          questions: true,
          todos: true,
          commands: true,
          fork: true,
          revert: true,
          unrevert: true,
          configOptions: false,
        }),
      })
    })

    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    const text = "core harness abort-disabled turn"
    await composePrompt(page, input, text)
    await ensureComposerModelSelected(page, { modelName: /^Big Pickle$/i, search: "Big Pickle" })
    await page.locator(SELECTORS.submitControl).last().click()
    await expect.poll(() => mock.requests.promptCount, { timeout: 15_000 }).toBe(1)

    // The optimistic send clears the composer, so it is blank while the mock holds
    // the turn busy for 3s (extended `idle` timing) — submit cannot show "stop"
    // (no abort capability) and cannot send (still busy), so it is disabled.
    const submit = page.locator(SELECTORS.submitControl).last()
    await expect(submit).toBeDisabled({ timeout: 10_000 })
    await expect(submit).not.toHaveAttribute("data-icon", "stop")

    // Busy-with-no-abort is not a stuck state: the turn completes and the reply lands.
    // Submit is still disabled after idle only because the composer is blank — the
    // universal can't-send-nothing rule, unrelated to the abort capability — so the
    // proof that nothing is locked out is that it re-enables once there is text.
    await expectAssistantReplyVisible(page, `ack 1: ${text}`)
    await expect(submit).toBeDisabled({ timeout: 10_000 })
    await composePrompt(page, page.getByRole("textbox", { name: /Ask anything/i }).last(), "follow-up after idle")
    await expect(submit).toBeEnabled({ timeout: 10_000 })
  })

  test("a stale, model-carrying options response does not clear the resolved model selection, and the retry does not change it", async ({
    page,
  }) => {
    const sessionId = "ses_core_harness_stale_options"
    const mock = await installMockRuntime(page, { dir: DIR, sessionId, harness: "acp:claude" })

    let optionsCalls = 0
    await page.route("**/api/claxedo/agent-config/harness/options**", (route) => {
      const type = route.request().resourceType()
      if (type !== "fetch" && type !== "xhr") return route.continue()
      optionsCalls += 1
      const stale = optionsCalls === 1
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          source: "harness",
          stale,
          options: [
            {
              id: "model",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: "claude-sonnet-4-6",
              selectOptions: [{ id: "claude-sonnet-4-6", name: "Sonnet 4.6" }],
            },
          ],
        }),
      })
    })

    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    // The hydrate path fetches config options too, so the stale-response route above is
    // exercised by auto-hydration alone — no manual click opens the picker here.
    await expectHarnessAutoHydrated(page, /^claude-acp$/)

    // A stale-but-populated response resolves the model immediately — never a
    // "Select model" placeholder in between.
    await expect(page.locator('[data-action="prompt-harness-model"]').last()).toContainText(/Sonnet 4\.6/i, {
      timeout: 5_000,
    })

    // The retry scheduled 1000ms later delivers the non-stale confirmation; assert it
    // actually happened and that the selection is untouched across the retry window.
    await expect.poll(() => optionsCalls, { timeout: 5_000 }).toBeGreaterThanOrEqual(2)
    await expect(page.locator('[data-action="prompt-harness-model"]').last()).toContainText(/Sonnet 4\.6/i, {
      timeout: 5_000,
    })

    const text = "core harness stale options turn"
    await composePrompt(page, input, text)
    await page.locator(SELECTORS.submitControl).last().click()
    await expect.poll(() => mock.requests.promptCount, { timeout: 15_000 }).toBe(1)
    expect(mock.requests.promptBodies[0]).toMatchObject({
      text,
      providerID: "claude-acp",
      modelID: "claude-sonnet-4-6",
    })
    await expect(page).toHaveURL(sessionUrlPattern(sessionId), { timeout: 20_000 })
    await expectAssistantReplyVisible(page, `ack 1: ${text}`)
  })

  // No draft-harness reset exists: an explicit agent choice is kept across navigation.
  // This pins the local half — a picked harness survives a same-pane reload. The
  // cross-workspace half needs a workspace-runtime ref, which `installMockRuntime`'s
  // local routes never produce, so it lives in `core-harness-ownership-cloud`.
  test(
    "a non-OpenCode harness picked on a local draft persists across a same-pane reload — never reset to OpenCode",
    async ({ page }) => {
      await seedOneProject(page, DIR)
      await installMockRuntime(page, { dir: DIR, sessionId: "ses_core_harness_persist", harness: "opencode" })
      await openDraftPrompt(page, DIR)

      await switchDraftHarness(page, /^Claude$/, 0)
      await expectHarnessAutoHydrated(page, /^Claude$/)
      await expect
        .poll(() =>
          page.evaluate(
            () => Object.entries(localStorage).find(([key]) => key.includes("session.draft-default.v1"))?.[1],
          ),
        )
        // The persisted `lastHarness` is the harness selection itself, and the
        // "Claude" row picked above is the native SDK harness, not an ACP connection.
        .toContain('"lastHarness":{"kind":"native","harnessId":"claude"')

      await openDraftPrompt(page, DIR)
      await expectHarnessAutoHydrated(page, /^Claude$/)
    },
  )

})
