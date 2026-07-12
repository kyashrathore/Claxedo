/**
 * SPEC: Model, effort/variant, and agent controls (plain OpenCode harness)
 *
 * PURPOSE — before/while talking to the model, the user must be able to see and change
 * *which* model answers, *how hard it thinks* (variant/effort), and *which agent
 * profile* handles the turn — and the app must refuse to silently guess when that
 * configuration is incomplete or unaffordable. This spec owns the plain-OpenCode-harness
 * composer controls that select model/variant/agent (`src/components/prompt-input/
 * toolbar-controls.tsx`, `model-control.tsx`), the free/paid gate that routes the model
 * trigger to either the full picker or `DialogSelectModelUnpaid`
 * (`src/components/dialog-select-model-unpaid.tsx`), the mid-session config PATCH that
 * persists a change (`src/context/local.tsx#syncSessionSelection`,
 * `src/components/prompt-input/submit-transport.ts#saveSessionConfig`), the
 * "nothing is selected" submit gate (`src/session/submit/resolve.ts
 * #resolveSubmittedConfig`), and the Settings→Models visibility toggle
 * (`src/components/settings-models.tsx`, `src/context/models.tsx`) that filters what the
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
 *     the MODEL CATALOG's global "recent" list (`useModels()`, `src/context/models.tsx`,
 *     persisted at localStorage key `opencode.global.dat:model` under `.recent`): picking
 *     a model calls `model.set(item, {recent:true})`, which pushes it onto
 *     `models.recent.list()`; on the next load, `currentModelKey()`'s fallback chain
 *     (`fallback = savedModel() ?? recentModel() ?? configuredModel() ?? defaultModel()`,
 *     `src/context/local.tsx:371`) picks the most-recently-used model back up as the
 *     active model even though the draft's own scope is empty.
 *   - Model VISIBILITY (Settings→Models) lives in `useModels()`'s `store.user` (also
 *     `opencode.global.dat:model`, the `.user` array of `{providerID,modelID,visibility}`
 *     rows), read by `models.visible()` (`src/context/models.tsx:115`): an explicit
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
 *     against the last-sent JSON via `savedSessionConfigQueryKey`). Both are the SAME
 *     REST endpoint. An EXISTING session's `config.model` (as last read from the
 *     session's info/list query), if present, is used AS-IS for the next send
 *     (`submit.ts:441` — `existingSessionConfig?.model` short-circuits
 *     `resolveSubmittedConfig`); this spec proves the mid-session change via the
 *     immediate PATCH `syncSessionSelection` fires, not by re-sending and re-parsing a
 *     GET that a mock server would have to fake livenes for.
 *
 * ANATOMY —
 *   `[data-action="prompt-model"]` — model control trigger. Renders as a plain `Button`
 *     (opens `DialogSelectModelUnpaid`) when `paidProviderCount() === 0` (all connected
 *     providers are cost-0 "opencode"), or as a `ModelSelectorPopover` trigger otherwise
 *     (`src/components/prompt-input/model-control.tsx`). Hidden entirely when the
 *     composer is in harness mode (ACP/SDK) — `core-harness-ownership-local` owns that
 *     surface via `AgentHarnessSelector`.
 *   `[data-slot="dialog-title"]` / `[data-slot="dialog-body"]` — `DialogSelectModelUnpaid`
 *     renders title "Select model" and a body listing free OpenCode models plus a
 *     "Add more models from popular providers" section — body text disambiguates it from
 *     any other same-titled dialog.
 *   `[data-slot="list-item"]` (inside the model popover's `List`) — one row per
 *     visible+matching model; text = model name.
 *   `[data-action="prompt-agent"]` — the plain agent `Select` trigger
 *     (`[data-slot="select-select-trigger"]`); only rendered when NOT harness mode AND
 *     `agentNames().length > 0` (`shouldShowPromptAgentSelector`,
 *     `src/components/prompt-input/selector-visibility.ts`); its `disabled` prop is wired
 *     to `harnessPending()` (composer.tsx passes `props.harnessPending` straight through
 *     `PromptToolbarControls`) — see HARNESS NOTES for why this can never actually render
 *     disabled in the current wiring.
 *   `[data-action="prompt-model-variant"]` — variant `Select` trigger; rendered only when
 *     `!harnessMode && variants().length > 1`, where `variants = ["default",
 *     ...currentModel.variants keys]` (`toolbar-state.ts:75`).
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
 *     Switch>`, `src/components/settings-models.tsx`).
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
 *      control opens `DialogSelectModelUnpaid` (free-models + "add more providers" body)
 *      instead of the full model popover.
 *   6. The plain agent `Select` renders once more than one agent profile is available,
 *      and picking a non-default agent is reflected in the next send's payload
 *      (`agent`).
 *   7. [Documented, not independently testable — see HARNESS NOTES] The agent selector's
 *      `disabled` prop tracks `harnessPending()`, but in the current wiring
 *      `showAgentSelector()` and `harnessPending()` are mutually exclusive states, so a
 *      "visible AND disabled" agent selector cannot be produced through the public
 *      composer surface today.
 *   8. A failed `PATCH /session/:id/config` shows a "Could not save session config" toast
 *      while the prompt send still proceeds and the reply still renders — see HARNESS
 *      NOTES for the two bugs this behavior guards against (both fixed 2026-07-10).
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
 *   - `providers.paid()` (`src/hooks/use-providers.ts:94`) counts a connected provider as
 *     paid iff its id is not `"opencode"`, or it IS `"opencode"` but has a model with
 *     `cost.input > 0`. The shared `mock-runtime.ts` always advertises the active
 *     harness's provider with `cost: {input:0, output:0}`, so with the DEFAULT mock the
 *     model control ALWAYS renders as the unpaid-dialog trigger for the `opencode`
 *     harness — behaviors 1–4, 6, 10 install an additional `page.route` override (this
 *     spec file only, not the shared helper) adding a connected `anthropic` provider with
 *     priced models to reach the full `ModelSelectorPopover`.
 *   - Behavior 8, bug #1 (fixed 2026-07-10): `saveSessionConfig`
 *     (`src/components/prompt-input/submit-transport.ts:203-217`) now throws on a non-ok
 *     PATCH response before reaching `queryClient.setQueryData` (previously `sessionRequest`
 *     resolving with a raw non-2xx `Response` — `fetch`/`authFetch`/`unsignedLocalFetch`
 *     only reject on network-level failures — meant the `catch` never ran and the dedupe
 *     cache silently marked a failed payload "saved").
 *   - Behavior 8, bug #2 (fixed 2026-07-10): even with bug #1 fixed, the toast never
 *     rendered because `prompt.toast.sessionConfigSaveFailed.title` had no entry in
 *     `src/i18n/en.ts` — `language.t()` (`@solid-primitives/i18n`'s `translator()`, see
 *     `src/context/language.tsx:222`) has no fallback-argument convention, so the missing
 *     key resolved to `undefined` rather than the `{fallback: "..."}` string passed at the
 *     call site (`submit.ts:233-235`). `showToast`'s `<Toast.Title>` is wrapped in
 *     `<Show when={opts.title}>` (`packages/ui/src/components/toast.tsx:131-133`), so a
 *     falsy title meant the title element — and hence `[data-slot="toast-title"]` — never
 *     mounted at all, even though `toaster.show()` itself ran without error. The key is now
 *     defined in `src/i18n/en.ts` alongside the other `prompt.toast.*.title` entries.
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
          "big-pickle": {
            id: "big-pickle",
            name: "Big Pickle",
            // See the `family` comment on the anthropic models below — a
            // provider's single model with an omitted `family` is ALSO
            // excluded from `latestSet` by the remeda `groupBy` bug (an
            // undefined-returning callback drops even a lone item), so this
            // needs a `family` too or Big Pickle silently defaults hidden.
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
            // (`src/context/models.tsx`'s `latest` memo groups
            // available models by `(provider.id, family)` via remeda's
            // `groupBy`). REAL BUG found while diagnosing this spec:
            // remeda's `groupBy` callback returning `undefined` EXCLUDES
            // the item from every group instead of bucketing it under an
            // "undefined" group (see `groupBy.d.ts`'s documented contract
            // — "allows the callback to return `undefined` in order to
            // exclude the item from being added to any group"). Since
            // `family` is optional on the real model schema
            // (`packages/core/src/models-dev.ts:50`), any provider with
            // TWO OR MORE models that both omit `family` has ALL of them
            // silently dropped from `latestSet` — not deduped to one
            // survivor as the code intends, but eliminated entirely —
            // which then defaults them to HIDDEN (any model with a valid,
            // non-"latest" release_date is hidden by
            // `models.tsx`'s `visible()`). This is why an earlier version
            // of this fixture (family omitted, matching the shared
            // mock-runtime.ts fixtures) rendered "No model results" for
            // every paid-provider test. Setting realistic distinct
            // `family` values per model here (as real catalogs — models.dev
            // — do for well-known model lines) sidesteps the bug the way
            // production data would; the underlying defect is reported
            // separately, not fixed here (out of scope for this spec).
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
    default: { opencode: "big-pickle", anthropic: "claude-sonnet-4-6" },
    connected: ["opencode", "anthropic"],
  }
}

/** Adds a connected, priced "anthropic" provider so paidProviderCount() > 0 and the
 * real ModelSelectorPopover (not DialogSelectModelUnpaid) renders. Registered AFTER
 * installMockRuntime so it wins (Playwright matches most-recently-registered first).
 *
 * REAL BUG worth noting for the shared helper: `bootstrap.ts#fetchProvider` issues a
 * SEPARATE directory-scoped refetch to `/provider?harness=<type>` (query string) after
 * the initial bootstrap-seeded provider data lands, and unconditionally overwrites the
 * query cache with whatever that returns (`setProviderQuery` only preserves the
 * existing cache when the NEW payload is empty, not when it merely differs) — see
 * `src/shell/data/bootstrap.ts:370-378`. `mock-runtime.ts` and earlier versions of this
 * fixture used the bare glob "star-star-slash-provider" (no trailing wildcard), which
 * does NOT match a URL carrying a query string (verified empirically: Playwright's
 * glob-to-regex anchors the pattern's end), so that refetch silently fell through to
 * the REAL shared dev server and clobbered the mocked paid-provider list with the real
 * backend's single-provider response — the exact cause of "Sonnet 4.6"/"Opus 4.7" never
 * appearing in the popover. Fixed here with a trailing wildcard so both the bare and
 * query-string forms are intercepted; the underlying gap in the shared helper is
 * reported in this task's findings, not fixed here (out of scope — see task rules). */
async function installPaidProviderFixture(page: Page, mock: MockRuntimeHandles) {
  const body = paidProviderBody()
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
        provider_auth: { opencode: [{ type: "api", label: "API key" }], anthropic: [{ type: "api", label: "API key" }] },
        config: { provider: { id: "opencode", model: "big-pickle" }, agent: { id: "build" } },
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
  return page.locator('[data-action="prompt-model"]').last()
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

  test("variant selector only renders for a multi-variant model, and the pick reaches the payload — behaviors 2", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await installPaidProviderFixture(page, mock)
    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    // Opus has zero variants configured in the fixture — no variant selector.
    await pickModelFromPopover(page, "Opus 4.7")
    await expect(modelTrigger(page)).toContainText("Opus 4.7", { timeout: 10_000 })
    await expect(page.locator('[data-action="prompt-model-variant"]')).toHaveCount(0)

    // Sonnet has {high, low} — the variant selector appears once it's current.
    await pickModelFromPopover(page, "Sonnet 4.6")
    await expect(modelTrigger(page)).toContainText("Sonnet 4.6", { timeout: 10_000 })
    const variantTrigger = page.locator('[data-action="prompt-model-variant"]').last()
    await expect(variantTrigger).toBeVisible({ timeout: 10_000 })
    await expect(variantTrigger).toContainText(/Default/i)

    await variantTrigger.click()
    const highOption = page.locator('[data-slot="select-select-item"]', { hasText: /^high$/i }).first()
    await expect(highOption).toBeVisible({ timeout: 10_000 })
    await highOption.click()
    await expect(variantTrigger).toContainText(/high/i, { timeout: 10_000 })

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
    await pickModelFromPopover(page, "Opus 4.7")
    await expect(modelTrigger(page)).toContainText("Opus 4.7", { timeout: 10_000 })

    await expect
      .poll(() => mock.requests.configPatchCount, { timeout: 15_000 })
      .toBeGreaterThan(patchesBeforeSwap)
    const swapPatch = mock.requests.configPatchBodies.at(-1)?.body as { model?: { providerID?: string; modelID?: string } } | undefined
    expect(swapPatch?.model).toMatchObject({ providerID: "anthropic", modelID: "claude-opus-4-7" })
  })

  test("a freshly picked model survives a page reload of the same draft — behavior 4", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await installPaidProviderFixture(page, mock)
    await seedOneProject(page, DIR)
    await openDraftPrompt(page, DIR)

    await pickModelFromPopover(page, "Opus 4.7")
    await expect(modelTrigger(page)).toContainText("Opus 4.7", { timeout: 10_000 })

    // The pick is persisted into the catalog's global "recent" list — wait for the
    // actual localStorage write (deterministic poll, not a sleep) before reloading.
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const raw = localStorage.getItem("opencode.global.dat:model")
          if (!raw) return null
          try {
            const parsed = JSON.parse(raw) as { recent?: Array<{ modelID?: string }> }
            return parsed.recent?.some((m) => m.modelID === "claude-opus-4-7") ?? false
          } catch {
            return null
          }
        }),
        { timeout: 10_000 },
      )
      .toBe(true)

    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    await expect(modelTrigger(page)).toContainText("Opus 4.7", { timeout: 20_000 })
  })

  test("zero-paid-provider path opens the unpaid model dialog — behavior 5", async ({ page }) => {
    // Deliberately the DEFAULT mock (no paid-provider override): mock-runtime's
    // opencode-harness provider always prices its model at cost 0 — see HARNESS NOTES.
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await seedOneProject(page, DIR)
    await openDraftPrompt(page, DIR)

    await modelTrigger(page).click()
    const dialogTitle = page.locator('[data-slot="dialog-title"]', { hasText: "Select model" })
    await expect(dialogTitle).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText("Free models provided by OpenCode")).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText("Add more models from popular providers")).toBeVisible({ timeout: 10_000 })
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

    const agentTrigger = page.locator('[data-action="prompt-agent"]').last()
    await expect(agentTrigger).toBeVisible({ timeout: 15_000 })
    await expect(agentTrigger).not.toBeDisabled()
    await expect(agentTrigger).toContainText(/build/i)

    await agentTrigger.click()
    const reviewOption = page.locator('[data-slot="select-select-item"]', { hasText: /^review$/i }).first()
    await expect(reviewOption).toBeVisible({ timeout: 10_000 })
    await reviewOption.click()
    await expect(agentTrigger).toContainText(/review/i, { timeout: 10_000 })

    const promptText = "which agent handled this"
    await input.click()
    await input.fill(promptText)
    await page.locator(SELECTORS.submitControl).last().click()

    await expect.poll(() => mock.requests.promptCount, { timeout: 15_000 }).toBe(1)
    await expectAssistantReplyVisible(page, `ack 1: ${promptText}`)
    expect(mock.requests.promptBodies[0]?.agent).toBe("review")
  })

  // Behavior 7: see SPEC HARNESS NOTES. `showAgentSelector()` and `harnessPending()` are
  // mutually exclusive in the current wiring (composer.tsx:91-101, selector-
  // visibility.ts) — a visible-and-disabled agent selector cannot be produced through the
  // public composer surface, so there is no positive scenario to pin here beyond what the
  // SPEC block already documents from source.
  test.fixme(
    "agent selector disabled-while-harnessPending is unreachable through the public composer surface — behavior 7 (see SPEC HARNESS NOTES, composer.tsx:91-101 + selector-visibility.ts)",
    async () => {},
  )

  // Behavior 8's two bugs (submit-transport.ts ignoring non-2xx on the config PATCH, and
  // the missing `prompt.toast.sessionConfigSaveFailed.title` i18n key hiding the toast's
  // title element entirely — see SPEC HARNESS NOTES) were fixed on 2026-07-10 — this test
  // is now the permanent regression guard.
  test(
    "failed config PATCH shows a toast while the send still proceeds — behavior 8",
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
      await expect.poll(() => mock.requests.promptCount, { timeout: 15_000 }).toBe(1)
      await expectAssistantReplyVisible(page, `ack 1: ${promptText}`)
      // Regression guard for a second, separate config-PATCH caller
      // (`src/context/local.tsx#syncSessionSelection`, no `harness` query param) that
      // shares this endpoint: a permanently-failing PATCH must not retry unboundedly.
      // A brand-new draft session's first submit only ever produces the one PATCH from
      // `submit-transport.ts#saveSessionConfig` above (`local.session.promote`'s sync is
      // gated off by `isOpenCodeSessionScope` until hydration settles, so it never fires
      // here) — pin that so a future change that fires both unconditionally is caught.
      // The intent here is the invariant that a *permanently-failing* config
      // PATCH must not retry unboundedly. Two callers share this endpoint —
      // `submit-transport.ts#saveSessionConfig` (fires once on submit) and
      // `src/context/session-selection.tsx#syncSessionSelection` (fires when
      // hydration settles, and may re-attempt a *bounded* number of times as
      // the session-config query refetches during hydration). Which of those
      // have fired by any fixed wall-clock instant is pure timing (a fast run
      // sees only the transport PATCH; a slower run sees the sync burst too),
      // so a magic-number ceiling here is inherently racy. Assert the real
      // invariant instead: the count CONVERGES (goes quiet) rather than
      // growing without bound. A future change that retries forever, or fires
      // both callers in an unbounded loop, never stabilizes and times out here.
      const configPatchSamples: number[] = []
      await expect
        .poll(
          () => {
            configPatchSamples.push(mock.requests.configPatchCount)
            const n = configPatchSamples.length
            return (
              n >= 3 &&
              configPatchSamples[n - 1] === configPatchSamples[n - 2] &&
              configPatchSamples[n - 2] === configPatchSamples[n - 3]
            )
          },
          { intervals: [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000], timeout: 20_000 },
        )
        .toBe(true)
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
    // defaults HIDDEN (src/context/models.tsx:115-124) — absent from the popover list.
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
