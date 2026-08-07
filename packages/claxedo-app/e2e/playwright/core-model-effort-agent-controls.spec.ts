/**
 * SPEC: Model, effort/variant, and agent controls (plain OpenCode harness)
 *
 * PURPOSE — before/while talking to the model, the user must be able to see and change
 * *which* model answers, *how hard it thinks* (variant/effort), and *which agent
 * profile* handles the turn — and the app must refuse to silently guess when that
 * configuration is incomplete or unaffordable. This spec owns the plain-OpenCode-harness
 * composer controls that select model/variant/agent (`src/components/prompt-input/
 * toolbar-controls.tsx`, `model-control.tsx`), the mid-session config PATCH that
 * persists a change (`src/context/local.tsx#syncSessionSelection`,
 * `src/components/prompt-input/submit-transport.ts#saveSessionConfig`), the
 * "nothing is selected" submit gate (`src/session/submit/resolve.ts
 * #resolveSubmittedConfig`), and the Settings→Models visibility toggle
 * (`src/features/settings/ui/models.tsx`, `src/features/session/providers/models.tsx`) that filters what the
 * composer's model list shows. ACP/harness-owned model pickers (`AgentHarnessSelector`)
 * are `core-harness-ownership-local`'s territory, not this spec's.
 *
 * STATE MODEL —
 *   - Model/agent/variant SELECTION lives in `useLocal()` (`src/context/local.tsx`), a
 *     per-directory store persisted via `Persist.workspace(directory, "model-selection")`
 *     (localStorage key `opencode.workspace.<dirhash>.dat:workspace:model-selection`),
 *     keyed by session id once a session exists (`saved.session[sessionId]`). Before a
 *     session exists (a fresh draft), `store.draft` holds the pick IN MEMORY ONLY — it
 *     does NOT survive reload by itself. What DOES survive reload for a fresh draft is
 *     the MODEL CATALOG's global "recent" list (`useModels()`, `src/features/session/providers/models.tsx`,
 *     persisted at localStorage key `opencode.global.dat:model` under `.recent`): picking
 *     a model calls `model.set(item, {recent:true})`, which pushes it onto
 *     `models.recent.list()`; on the next load, `currentModelKey()`'s fallback chain
 *     (`fallback = savedModel() ?? recentModel() ?? configuredModel() ?? defaultModel()`,
 *     `src/context/local.tsx:371`) picks the most-recently-used model back up as the
 *     active model even though the draft's own scope is empty.
 *   - Model VISIBILITY (Settings→Models) lives in `useModels()`'s `store.user` (also
 *     `opencode.global.dat:model`, the `.user` array of `{providerID,modelID,visibility}`
 *     rows), read by `models.visible()` (`src/features/session/providers/models.tsx:118`): an explicit
 *     "hide"/"show" wins; otherwise a model released within ~6 months defaults visible
 *     ("latest"), otherwise a model with a KNOWN release date older than that defaults
 *     HIDDEN, otherwise (unknown/invalid date) defaults visible. This is a single GLOBAL
 *     reactive store — a Settings dialog toggle takes effect in the composer's model
 *     popover immediately, no reload needed (same signal, both are just consumers).
 *   - The SERVER's copy of session config (`PATCH /session/:id/config`) is a *write-only*
 *     projection for this spec's purposes: `context/local.tsx#syncSessionSelection`
 *     PATCHes it immediately whenever `local.model.set()`/`local.agent.set()` commits
 *     while the session is in "opencode scope" (`isOpenCodeSessionScope`); separately,
 *     `submit-transport.ts#saveSessionConfig` PATCHes it again at send time (deduped
 *     against the canonical session-config query cache). Both are the SAME
 *     REST endpoint. An EXISTING session's `config.model` (as last read from the
 *     session's info/list query), if present, is used AS-IS for the next send
 *     (`submit.ts:441` — `existingSessionConfig?.model` short-circuits
 *     `resolveSubmittedConfig`); this spec proves the mid-session change via the
 *     immediate PATCH `syncSessionSelection` fires, not by re-sending and re-parsing a
 *     GET that a mock server would have to fake livenes for.
 *
 * ANATOMY —
 *   `[data-action="prompt-harness-model"]` — the unified harness/model/effort trigger.
 *     For this OpenCode-focused spec it opens the ordinary searchable model list.
 *   `[data-slot="list-item"]` (inside the model popover's `List`) — one row per
 *     visible+matching model; text = model name.
 *   `[data-action="prompt-add"]` — the `+` trigger (`add-menu.tsx`); `disabled` while
 *     `harnessPending()` or outside normal mode.
 *   `[data-action="prompt-agent"]` — an agent RADIO ITEM inside the `+` menu, one per
 *     agent, carrying `data-checked` on the current one. Rendered when NOT harness mode
 *     AND `agentNames().length > 0` (`shouldShowPromptAgentSelector`,
 *     `src/components/prompt-input/selector-visibility.ts`) AND the agent list is not
 *     exactly build+plan — that pair collapses into the single
 *     `[data-action="prompt-plan-mode"]` checkbox instead (`planModeAgents()`). Both sit
 *     BELOW a separator, under the four flat action entries the menu now leads with.
 *     There is no inline agent trigger any more, so the current agent is only
 *     observable by reopening the menu and reading `data-checked`.
 *   The unified popover adds an Effort section only when the current model has multiple
 *     variants. Its button rows commit the same variant carried by prompt payloads.
 *   `[data-slot="select-select-item"]` / `[data-slot="select-select-item-label"]` — agent
 *     and variant option rows once a `Select` trigger is opened.
 *   `[data-slot="toast-title"]` — toast title text (`showToast` from `@opencode-ai/ui/
 *     toast`); "Select an agent and model" for the missing-model gate
 *     (`prompt.toast.modelAgentRequired.title`), "Could not save session config" for a
 *     failed config PATCH (`prompt.toast.sessionConfigSaveFailed.title`, sourced from
 *     `src/i18n/en.ts` — see BEHAVIORS #8 / HARNESS NOTES).
 *   Settings dialog: opened via the sidebar's `Settings`-labelled icon button
 *     (rail account menu item "Settings"); `role="tab"` item named "Models"
 *     (`language.t("settings.tab.models" is actually "settings.models.title")`);
 *     `SettingsModels` renders one row per model with a `role="switch"` control whose
 *     accessible name is the model's display name (`<Switch hideLabel>{item.name}</
 *     Switch>`, `src/features/settings/ui/models.tsx:114-122`).
 *
 * BEHAVIORS —
 *   1. Selecting a paid model before the first send is reflected in that send's
 *      `prompt_async` payload (`model.providerID`/`model.modelID`).
 *   2. Selecting a variant (effort level) before the first send is reflected in that
 *      send's payload (`variant`), and the variant `Select` only renders at all once the
 *      current model exposes more than one variant option.
 *   3. Changing the model on an EXISTING (already-created) session immediately fires a
 *      `PATCH /session/:id/config` carrying the newly picked model — the mid-session
 *      write path is independent of sending another prompt.
 *   4. A freshly picked model survives a full page reload of the same draft: the model
 *      trigger shows the picked model's name again with no user action, sourced from the
 *      catalog's global "recent" fallback (localStorage `opencode.global.dat:model`).
 *   5. With only a free (cost-0, `opencode`) provider connected, clicking the model
 *      control still opens the full model popover — no funnel dialog intercepts it.
 *   6. The plain agent `Select` renders once more than one agent profile is available,
 *      and picking a non-default agent is reflected in the next send's payload
 *      (`agent`).
 *   7. [Documented, not independently testable — see HARNESS NOTES] The agent selector's
 *      `disabled` prop tracks `harnessPending()`, but in the current wiring
 *      `showAgentSelector()` and `harnessPending()` are mutually exclusive states, so a
 *      "visible AND disabled" agent selector cannot be produced through the public
 *      composer surface today.
 *   8. A failed first `PATCH /session/:id/config` shows a "Could not save session config"
 *      toast and keeps the new session unpublished: the draft remains intact and no
 *      prompt request is made.
 *   9. With zero resolvable model (no connected providers at all), pressing Enter to
 *      submit blocks the send: a "Select an agent and model" toast appears, the composer
 *      text is preserved verbatim, and zero `prompt_async` requests are made.
 *   10. Toggling a model's visibility off in Settings → Models removes it from the
 *       composer's model popover; toggling it back on restores it — no reload needed.
 *
 * INVARIANTS — exactly one model control exists in the DOM at a time (INVARIANTS.md #1,
 *   scoped here to plain-OpenCode mode only; the harness-owned case is spec 3's); a
 *   config-PATCH failure must never block the send itself (see behavior 8); the submit
 *   control's gating for "no model resolvable" is enforced
 *   both by disabling `[data-action="prompt-submit"]` AND by a defensive server-side-of-
 *   the-guard toast reachable via Enter (INVARIANTS.md #4 — "never assert readiness via a
 *   fixed sleep" honored throughout via `expect.poll`/request-log assertions).
 *
 * HARNESS NOTES —
 *   - The shared `mock-runtime.ts` always advertises the active harness's provider with
 *     `cost: {input:0, output:0}`, and its single model is not enough to exercise the
 *     picker's model/variant rows — so behaviors 1–4, 6, 10 install an additional
 *     `page.route` override (this spec file only, not the shared helper) adding a
 *     connected `anthropic` provider with priced, multi-variant models.
 *   - Behavior 8 pins the creation boundary: the authoritative config PATCH completes
 *     before local session promotion. A non-2xx response therefore preserves the draft
 *     instead of exposing a session whose harness/model contract is incomplete.
 *   - Behavior 7's non-testability: `showAgentSelector()` requires
 *     `toolbarHarnessMode(scope()) === false`; `harnessPending()` requires
 *     `isHarnessMode(scope()) === true` (a strictly narrower predicate than
 *     `toolbarHarnessMode`, since `toolbarHarnessMode = isComposerHarnessMode(mode) ||
 *     harnessController.isHarnessMode(scope) || harnessSelectionController?.read(scope)
 *     .isHarnessMode`, a superset of the terms `isHarnessMode` checks — see
 *     `composer.tsx:91-101`). Any scope where `isHarnessMode` is true therefore also has
 *     `toolbarHarnessMode` true, which hides the agent selector outright. The two states
 *     cannot coexist through the public composer surface as currently wired.
 *
 * OUT OF SCOPE — ACP/SDK harness model+effort pickers (`AgentHarnessSelector`,
 *   `core-harness-ownership-local`); busy/abort/error UI (`core-busy-abort-errors`);
 *   slash/shell/@-mention composer modes (`core-composer-modes`); permission/question/
 *   todo docks (`core-docks`); multi-turn reload/history mechanics beyond the single
 *   reload-persistence check in behavior 4 (`core-turns-reload-recovery`).
 */
import { expect, test, type Page } from "@playwright/test"
import { installMockRuntime, type MockRuntimeHandles } from "../helpers/mock-runtime"
import { expectAssistantReplyVisible, SELECTORS } from "../helpers/turn-oracle"

const DIR = "/tmp/e2e-core-model-effort-agent-controls"
const SESSION_ID = "ses_core_model_effort_agent"

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

async function seedOneProject(page: Page, dir: string) {
  // `page.addInitScript` re-runs this script on EVERY navigation in this browser
  // context, including `page.reload()` — not just the first `page.goto()`. An
  // unconditional `localStorage.clear()` here would silently wipe out any
  // persisted app state (e.g. the model catalog's "recent" list) written between
  // the initial load and a later reload within the same test, defeating any
  // reload-persistence assertion. Guard the clear with a marker so it only fires
  // once per fresh context (every test already gets its own isolated context, so
  // this is not a cross-test isolation concern) — subsequent reloads within the
  // same test keep whatever the app itself persisted.
  await page.addInitScript((d: string) => {
    if (!sessionStorage.getItem("__e2e_seed_done__")) {
      localStorage.clear()
      sessionStorage.setItem("__e2e_seed_done__", "1")
    }
    ;(window as typeof window & { __OPENCODE__?: { serverUrl?: string; activeDirectory?: string } }).__OPENCODE__ = {
      serverUrl: window.location.origin,
      activeDirectory: d,
    }
    localStorage.setItem(
      "opencode.global.dat:server",
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

async function openDraftPrompt(page: Page, dir: string) {
  await page.goto(`/${slug(dir)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await expect(input).toBeVisible({ timeout: 20_000 })
  return input
}

function isApiRequest(route: import("@playwright/test").Route) {
  const type = route.request().resourceType()
  return type === "fetch" || type === "xhr"
}

function paidProviderBody() {
  return {
    all: [
      {
        id: "opencode",
        name: "opencode",
        env: [],
        models: {
          "big-pickle-1": {
            id: "big-pickle-1",
            name: "Big Pickle",
            // See the `family` comment on the anthropic models below. `family` is
            // optional on the real schema, and since the fix cited there each model
            // without one falls back to its own id as the group key, so this could be
            // omitted — it is kept because real catalogs carry it and the fixture should
            // look like production data.
            family: "big-pickle",
            release_date: "2026-06-15",
            attachment: true,
            reasoning: true,
            temperature: true,
            tool_call: true,
            limit: { context: 200000, output: 8192 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
      },
      {
        id: "anthropic",
        name: "Anthropic",
        env: [],
        models: {
          "claude-sonnet-4-6": {
            id: "claude-sonnet-4-6",
            name: "Sonnet 4.6",
            // family disambiguates each model within a provider for the
            // catalog's "latest per family" auto-visibility computation
            // (`src/features/session/providers/models.tsx`'s `latest` memo,
            // lines 60-88, groups available models by `(provider.id, family)`
            // via remeda's `groupBy`).
            //
            // HISTORY — FIXED IN THE APP, no longer a live bug (re-verified
            // 2026-07-25). This fixture was originally written around a real
            // defect: remeda's `groupBy` callback returning `undefined`
            // EXCLUDES the item from every group instead of bucketing it under
            // an "undefined" group (see `groupBy.d.ts`'s documented contract —
            // "allows the callback to return `undefined` in order to exclude
            // the item from being added to any group"). Since `family` is
            // optional on the real model schema
            // (`packages/core/src/models-dev.ts:50` — still `Schema.optional`),
            // every model that omitted it silently vanished from `latestSet`
            // and then defaulted to HIDDEN (a model with a valid, non-"latest"
            // release_date is hidden by `models.tsx`'s `visible()`) — which is
            // why an early version of this fixture rendered "No model results"
            // for every paid-provider test. The app now keys the inner group by
            // `x.family ?? x.id` (`models.tsx:77`), so an absent `family` no
            // longer drops the model; the fix has its own source-level
            // regression guard plus a remeda-contract reproduction in
            // `src/features/session/providers/models.test.ts`.
            //
            // The distinct `family` values are therefore no longer load-bearing
            // for visibility — they stay because real catalogs (models.dev) set
            // them for well-known model lines, so the fixture matches production
            // shape rather than exercising the fallback path by accident.
            family: "claude-sonnet",
            release_date: "2026-06-01",
            attachment: true,
            reasoning: true,
            temperature: true,
            tool_call: true,
            limit: { context: 200000, output: 8192 },
            cost: { input: 3, output: 15 },
            options: {},
            variants: { high: {}, low: {} },
          },
          "claude-opus-4-7": {
            id: "claude-opus-4-7",
            name: "Opus 4.7",
            family: "claude-opus",
            release_date: "2026-06-02",
            attachment: true,
            reasoning: true,
            temperature: true,
            tool_call: true,
            limit: { context: 200000, output: 8192 },
            cost: { input: 15, output: 75 },
            options: {},
          },
          "claude-haiku-3": {
            id: "claude-haiku-3",
            name: "Haiku 3 (legacy)",
            family: "claude-haiku",
            release_date: "2020-03-01",
            attachment: true,
            reasoning: true,
            temperature: true,
            tool_call: true,
            limit: { context: 200000, output: 8192 },
            cost: { input: 0.25, output: 1.25 },
            options: {},
          },
        },
      },
    ],
    default: { opencode: "big-pickle-1", anthropic: "claude-sonnet-4-6" },
    connected: ["opencode", "anthropic"],
  }
}

/** Adds a connected, priced Anthropic provider. Bootstrap supplies the canonical
 * compact index (one configured default per connected provider); `/provider` supplies
 * full details for explicit detail loading. Registered after the shared runtime so both
 * routes own the catalog used by this scenario. */
async function installPaidProviderFixture(page: Page, mock: MockRuntimeHandles) {
  const body = paidProviderBody()
  const defaults: Record<string, string> = body.default
  const index = {
    ...body,
    all: body.all.map((provider) => ({
      ...provider,
      models: Object.fromEntries(Object.entries(provider.models).filter(([id]) => defaults[provider.id] === id)),
    })),
  }
  await page.route("**/provider**", (route) => {
    if (!isApiRequest(route)) return route.continue()
    if (new URL(route.request().url()).pathname !== "/provider") return route.fallback()
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) })
  })
  await page.route("**/api/claxedo/bootstrap**", (route) => {
    if (!isApiRequest(route)) return route.continue()
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        healthy: true,
        version: "1.0.0-test",
        path: { state: "", config: "", worktree: mock.session.dir, directory: mock.session.dir, home: "/tmp" },
        project: [{ id: mock.session.projectId, worktree: mock.session.dir, name: "mock-runtime", time: { created: Date.now(), updated: Date.now() } }],
        provider: index,
        provider_auth: { opencode: [{ type: "api", label: "API key" }], anthropic: [{ type: "api", label: "API key" }] },
        config: { provider: { id: "opencode", model: "big-pickle-1" }, agent: { id: "build" } },
      }),
    })
  })
}

/** Zero connected providers at all — no model is resolvable, selected or fallback. */
async function installNoModelFixture(page: Page, mock: MockRuntimeHandles) {
  const body = { all: [], default: {}, connected: [] }
  await page.route("**/provider**", (route) => {
    if (!isApiRequest(route)) return route.continue()
    if (new URL(route.request().url()).pathname !== "/provider") return route.fallback()
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) })
  })
  await page.route("**/api/claxedo/bootstrap**", (route) => {
    if (!isApiRequest(route)) return route.continue()
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        healthy: true,
        version: "1.0.0-test",
        path: { state: "", config: "", worktree: mock.session.dir, directory: mock.session.dir, home: "/tmp" },
        project: [{ id: mock.session.projectId, worktree: mock.session.dir, name: "mock-runtime", time: { created: Date.now(), updated: Date.now() } }],
        provider: body,
        provider_auth: {},
        config: {},
      }),
    })
  })
}

function modelTrigger(page: Page) {
  return page.locator('[data-action="prompt-harness-model"]').last()
}

async function openModelPopover(page: Page) {
  await modelTrigger(page).click()
  const list = page.locator('[data-slot="list-scroll"]').last()
  await expect(list).toBeVisible({ timeout: 25_000 })
  return list
}

async function pickModelFromPopover(page: Page, modelName: string) {
  await openModelPopover(page)
  const item = page.locator('[data-slot="list-item"]', { hasText: modelName }).first()
  // The popover's model list is sourced from the provider query (`useProviders()`,
  // staleTime 5min) — under heavy parallel-suite load the initial fetch can take
  // longer than a tight timeout; this is a real network-backed wait (not a sleep),
  // so give it real headroom rather than tightening a fixed poll interval.
  await expect(item).toBeVisible({ timeout: 25_000 })
  await item.click()
}

test.describe("core model, effort/variant, and agent controls @core", () => {
  test("model picked before first send is reflected in the prompt payload — behavior 1", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await installPaidProviderFixture(page, mock)
    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    await pickModelFromPopover(page, "Sonnet 4.6")
    await expect(modelTrigger(page)).toContainText("Sonnet 4.6", { timeout: 10_000 })

    const promptText = "which model answered this"
    await input.click()
    await input.fill(promptText)
    await page.locator(SELECTORS.submitControl).last().click()

    await expect.poll(() => mock.requests.promptCount, { timeout: 15_000 }).toBe(1)
    await expectAssistantReplyVisible(page, `ack 1: ${promptText}`)

    expect(mock.requests.promptBodies[0]?.providerID).toBe("anthropic")
    expect(mock.requests.promptBodies[0]?.modelID).toBe("claude-sonnet-4-6")
  })

  test("the Effort section only renders for a multi-variant model, and the pick reaches the payload — behavior 2", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await installPaidProviderFixture(page, mock)
    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    // Big Pickle has zero variants configured in the bootstrap index — no effort section.
    await pickModelFromPopover(page, "Big Pickle")
    await expect(modelTrigger(page)).toContainText("Big Pickle", { timeout: 10_000 })
    await modelTrigger(page).click()
    const opusPicker = page.locator('[data-component="harness-model-picker"]')
    await expect(opusPicker.locator('[data-slot="harness-picker-section"]', { hasText: /^Effort/ })).toHaveCount(0)
    await page.keyboard.press("Escape")

    // Sonnet has {high, low} — the effort section appears once it's current.
    await pickModelFromPopover(page, "Sonnet 4.6")
    await expect(modelTrigger(page)).toContainText("Sonnet 4.6", { timeout: 10_000 })
    await modelTrigger(page).click()
    const picker = page.locator('[data-component="harness-model-picker"]')
    const effortSection = picker.locator('[data-slot="harness-picker-section"]', { hasText: /^Effort/ })
    await expect(effortSection).toContainText(/Default/i)
    await effortSection.click()
    const highOption = picker.getByRole("button", { name: /^high$/i })
    await expect(highOption).toBeVisible({ timeout: 10_000 })
    await highOption.click()
    await expect(modelTrigger(page)).toContainText(/high/i, { timeout: 10_000 })

    const promptText = "how hard did you think about this"
    await input.click()
    await input.fill(promptText)
    await page.locator(SELECTORS.submitControl).last().click()

    await expect.poll(() => mock.requests.promptCount, { timeout: 15_000 }).toBe(1)
    await expectAssistantReplyVisible(page, `ack 1: ${promptText}`)
    expect(mock.requests.promptBodies[0]?.variant).toBe("high")
  })

  test("mid-session model change PATCHes the session config immediately — behavior 3", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await installPaidProviderFixture(page, mock)
    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    const promptText = "first turn before the model swap"
    await input.click()
    await input.fill(promptText)
    await page.locator(SELECTORS.submitControl).last().click()
    await expect.poll(() => mock.requests.promptCount, { timeout: 15_000 }).toBe(1)
    await expectAssistantReplyVisible(page, `ack 1: ${promptText}`)

    const patchesBeforeSwap = mock.requests.configPatchCount
    await pickModelFromPopover(page, "Big Pickle")
    await expect(modelTrigger(page)).toContainText("Big Pickle", { timeout: 10_000 })

    await expect
      .poll(() => mock.requests.configPatchCount, { timeout: 15_000 })
      .toBeGreaterThan(patchesBeforeSwap)
    const swapPatch = mock.requests.configPatchBodies.at(-1)?.body as { model?: { providerID?: string; modelID?: string } } | undefined
    expect(swapPatch?.model).toMatchObject({ providerID: "opencode", modelID: "big-pickle-1" })
  })

  test("a freshly picked model survives a page reload of the same draft — behavior 4", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await installPaidProviderFixture(page, mock)
    await seedOneProject(page, DIR)
    await openDraftPrompt(page, DIR)

    await pickModelFromPopover(page, "Big Pickle")
    await expect(modelTrigger(page)).toContainText("Big Pickle", { timeout: 10_000 })

    // The pick is persisted into the catalog's global "recent" list — wait for the
    // actual localStorage write (deterministic poll, not a sleep) before reloading.
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const raw = localStorage.getItem("opencode.global.dat:model")
          if (!raw) return null
          try {
            const parsed = JSON.parse(raw) as { recent?: Array<{ modelID?: string }> }
            return parsed.recent?.some((m) => m.modelID === "big-pickle-1") ?? false
          } catch {
            return null
          }
        }),
        { timeout: 10_000 },
      )
      .toBe(true)

    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    await expect(modelTrigger(page)).toContainText("Big Pickle", { timeout: 20_000 })
  })

  test("zero-paid-provider path still opens the standard model picker — behavior 5", async ({ page }) => {
    // Deliberately the DEFAULT mock (no paid-provider override): mock-runtime's
    // opencode-harness provider always prices its model at cost 0 — see HARNESS NOTES.
    // Having no PRICED provider used to divert this click into a Claxedo-only
    // "unpaid model" funnel dialog, which dead-ended on an empty free-model list.
    // The model control now opens the ordinary picker in every state; the picker
    // carries its own connect affordances for an unconfigured workspace.
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await seedOneProject(page, DIR)
    await openDraftPrompt(page, DIR)

    await openModelPopover(page)
    await expect(page.getByText("Free models provided by OpenCode")).toHaveCount(0)
    await expect(page.getByText("Add more models from popular providers")).toHaveCount(0)
  })

  test("multi-agent selector renders and the pick reaches the payload — behavior 6", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await page.route("**/api/claxedo/agent-config/agents**", (route) => {
      if (!isApiRequest(route)) return route.continue()
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { id: "build", name: "build", mode: "primary" },
          { id: "review", name: "review", mode: "primary" },
        ]),
      })
    })
    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    // The agent picker is no longer an inline chip: it is a radio group inside the
    // `+` menu (add-menu.tsx). The fixture's agents are build+review, which is NOT
    // the build+plan pair `planModeAgents()` collapses into a "Plan mode" checkbox,
    // so the explicit radio group is what renders here.
    const addTrigger = page.locator('[data-action="prompt-add"]').last()
    await expect(addTrigger).toBeVisible({ timeout: 15_000 })
    await expect(addTrigger).not.toBeDisabled()

    await addTrigger.click()
    const agentItems = page.locator('[data-action="prompt-agent"]')
    await expect(agentItems.filter({ hasText: /^build$/i })).toHaveAttribute("data-checked", "", { timeout: 10_000 })
    const reviewOption = agentItems.filter({ hasText: /^review$/i }).first()
    await expect(reviewOption).toBeVisible({ timeout: 10_000 })
    await reviewOption.click()

    // Reopen to confirm the pick stuck: the checked indicator is the only place the
    // current agent is visible now that the trigger is a bare `+`.
    await addTrigger.click()
    await expect(agentItems.filter({ hasText: /^review$/i })).toHaveAttribute("data-checked", "", { timeout: 10_000 })
    await page.keyboard.press("Escape")

    const promptText = "which agent handled this"
    await input.click()
    await input.fill(promptText)
    await page.locator(SELECTORS.submitControl).last().click()

    await expect.poll(() => mock.requests.promptCount, { timeout: 15_000 }).toBe(1)
    await expectAssistantReplyVisible(page, `ack 1: ${promptText}`)
    expect(mock.requests.promptBodies[0]?.agent).toBe("review")
  })

  test("session config rejects a harness identity change with the canonical 409 contract", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await seedOneProject(page, DIR)
    await openDraftPrompt(page, DIR)

    const result = await page.evaluate(async ({ directory, sessionID }) => {
      const response = await fetch(`/session/${sessionID}/config?directory=${encodeURIComponent(directory)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ harness: { type: "claude-acp" } }),
      })
      return { status: response.status, body: await response.json() }
    }, { directory: DIR, sessionID: SESSION_ID })

    expect(result).toEqual({
      status: 409,
      body: {
        ok: false,
        error: {
          code: "unsupported_operation",
          operation: "harness_switch",
          capability: "session_harness",
          harness: "opencode",
          transport: "opencode",
          reason: "harness_switch_not_supported",
          message: "opencode sessions cannot switch to claude through session config patch",
        },
      },
    })
  })

  // Behavior 7 (former fixme, deleted): the agent picker is now positively gated to the
  // OpenCode harness — `showAgentSelector()` is `isOpenCodeHarness && agentCount > 0`
  // (selector-visibility.ts, fed by `currentHarnessType(scope) === "opencode"` in
  // composer.tsx). OpenCode drafts never enter `harnessPending()` (pending requires a
  // non-OpenCode harness in "polling"), so a visible-and-disabled agent selector still
  // cannot be produced. The positive "shows for OpenCode with agents" contract is pinned
  // by behavior 6 above; the "hidden for non-OpenCode harnesses" half is
  // core-harness-ownership-local's territory (this spec is plain-OpenCode only).

  test(
    "failed first config PATCH preserves the unpublished draft — behavior 8",
    async ({ page }) => {
      const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, configPatchFailure: true })
      await seedOneProject(page, DIR)
      const input = await openDraftPrompt(page, DIR)

      const promptText = "does the save-failed toast appear"
      await input.click()
      await input.fill(promptText)
      await page.locator(SELECTORS.submitControl).last().click()

      await expect.poll(() => mock.requests.configPatchCount, { timeout: 15_000 }).toBeGreaterThan(0)
      await expect(page.locator('[data-slot="toast-title"]', { hasText: "Could not save session config" })).toBeVisible({
        timeout: 10_000,
      })
      await expect(input).toContainText(promptText)
      await expect.poll(() => mock.requests.promptCount, { intervals: [500, 1000, 1000], timeout: 3_000 }).toBe(0)
      expect(mock.requests.configPatchCount).toBe(1)
      expect(mock.requests.createSessionCount).toBe(1)
    },
  )

  test("missing model blocks submit with a toast and preserves the composer text — behavior 9", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await installNoModelFixture(page, mock)
    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    const promptText = "this should never be sent"
    await input.click()
    await input.fill(promptText)
    await expect(input).toContainText(promptText, { timeout: 10_000 })

    // The submit button is disabled while blocked (INVARIANTS.md #4); Enter still routes
    // through handleSubmit's own defensive guard, which is the behavior under test.
    await input.press("Enter")

    await expect(page.locator('[data-slot="toast-title"]', { hasText: "Select an agent and model" })).toBeVisible({
      timeout: 10_000,
    })
    await expect(input).toContainText(promptText)
    expect(mock.requests.promptCount).toBe(0)
    expect(mock.requests.createSessionCount).toBe(0)
  })

  test("Settings -> Models visibility toggle propagates to the composer's model list — behavior 10", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await installPaidProviderFixture(page, mock)
    await seedOneProject(page, DIR)
    await openDraftPrompt(page, DIR)

    // Haiku 3 has an old (2020) release date and no explicit visibility row yet, so it
    // defaults HIDDEN (src/features/session/providers/models.tsx:118-131) — absent from the popover list.
    await openModelPopover(page)
    await expect(page.locator('[data-slot="list-item"]', { hasText: "Haiku 3 (legacy)" })).toHaveCount(0)
    await page.keyboard.press("Escape")

    await page.getByTestId("rail-account-trigger").click()
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click()
    const dialog = page.locator('[data-slot="dialog-container"]')
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    await page.getByRole("tab", { name: "Models" }).click()

    const toggle = page.getByRole("switch", { name: "Haiku 3 (legacy)" })
    await expect(toggle).toBeVisible({ timeout: 10_000 })
    const toggleVisual = page
      .locator('[data-component="switch"]')
      .filter({ has: toggle })
      .locator('[data-slot="switch-control"]')
    await toggleVisual.click()
    await expect(toggle).toHaveAttribute("aria-checked", "true", { timeout: 10_000 })

    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)

    await openModelPopover(page)
    await expect(page.locator('[data-slot="list-item"]', { hasText: "Haiku 3 (legacy)" })).toBeVisible({ timeout: 10_000 })
  })
})
