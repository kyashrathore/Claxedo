/**
 * SPEC: Local session harness ownership (the harness matrix)
 *
 * PURPOSE — a local session can run on one of several agent "harnesses" instead of
 * plain OpenCode: Claude and Codex each via an ACP subprocess or a native SDK
 * integration, Cursor via ACP or its native SDK, and Pi (a fixed-model, always-ready
 * harness). Whichever harness is selected must own the session's model, agent, and
 * submit payload end to end — a user picking "Claude" must never have their prompt
 * silently routed through plain OpenCode, and switching harnesses must never leave two
 * conflicting model pickers on screen at once.
 *
 * STATE MODEL — harness selection lives in a client-local `harnessStore`
 * (`src/claxedo-ui/context/harness-store.ts`), keyed by a pane-preference `scope`
 * string (`panePreferenceScope({directory, sessionId, surfaceId, draftId})`) and
 * persisted to `localStorage` per scope (harness id, model id, agent name — see
 * `src/claxedo-ui/context/harness-preferences.ts`). It is NOT part of the server
 * session row while still a draft. `AgentHarnessSelector`
 * (`src/claxedo-ui/components/agent-harness-selector.tsx`) reads/writes it through a
 * `HarnessSelectionController` (`src/session-client/harness/controller.ts`).
 *   - Draft (no session yet), two ways to land on a harness: (a) the user picks one
 *     from the `<Select>`, which POSTs `/api/claxedo/agent-config/harness` `{type}`
 *     (`switchDraftHarness` in `src/claxedo-ui/context/harness-switcher.ts`); (b) on
 *     mount, `AgentHarnessSelector`'s effect unconditionally calls `hydrate()`
 *     (`src/claxedo-ui/context/harness-hydrator.ts:89-145`), which GETs the SAME
 *     `/api/claxedo/agent-config/harness` endpoint and — for a fresh draft, when
 *     `shouldHydrateDraftFromHarnessStatus` is true (local-transport + not a
 *     workspace-runtime pane) — silently APPLIES whatever harness that endpoint
 *     reports as "current" (`applyAndMarkSeen`/`applyStatus`,
 *     `src/claxedo-ui/context/harness-status-actions.ts:63-76`), with zero user
 *     interaction. A workspace whose backend already reports a non-`opencode` harness
 *     therefore renders that harness selected from the very first paint — this spec's
 *     harness-matrix cases exercise path (b) (a real workspace already wired to a
 *     harness); behavior 1's test is the one case that exercises path (a) (a user
 *     manually switching away from a workspace hydrated to `opencode`). For any
 *     harness with config options (`harnessHasConfigOptions` — every harness except
 *     `opencode` and `pi`, `src/session-client/harness/profile.ts:40`), BOTH paths also
 *     GET `/api/claxedo/agent-config/harness/options` to populate the model list
 *     (`src/claxedo-ui/context/harness-options-loader.ts`; the hydrate path fetches it
 *     via `applyStatus`'s own `shouldFetchConfigOptionsForScope` check). A `stale:true`
 *     options response with no models is applied WITHOUT touching the currently
 *     selected model (`applyHarnessOptionsResponse`'s empty branch only writes
 *     `selectedModel` when `!payload.stale`,
 *     `src/session-client/harness/options-state.ts:45-64`) and schedules an automatic
 *     retry after 1000ms, up to `MODEL_OPTIONS_RETRY_LIMIT` (5) tries
 *     (`src/claxedo-ui/context/harness-options-loader.ts:76`,
 *     `src/session-client/harness/store-policy.ts:18`).
 *   - First send: the harness/model chosen at send time become the session's owning
 *     harness — `POST /session/:id/prompt_async` carries `{model:{providerID,modelID},
 *     agent}` resolved from `harnessModelKeyForSubmit`
 *     (`src/session-client/harness/selection.ts:47-55`; for `opencode`,
 *     `providerID/modelID` come from the plain model picker instead — out of scope
 *     here, see `core-model-effort-agent-controls`).
 *   - Existing session: harness is LOCKED — `sessionLocked` in
 *     `src/session-client/composer/composer.tsx:731` is
 *     `harnessSessionId() !== undefined && harnessSessionId() !== "new"`, which disables
 *     the harness `<Select>` (`harnessDisabled` in
 *     `agent-harness-selector.tsx:180`); nothing in this codebase migrates an existing
 *     session's backing harness.
 *   - Readiness — `harnessStatusPatch` (`src/session-client/harness/store-state.ts:70-85`)
 *     computes `readiness: failedHarness(data) ? "error" : "ready"` — it is a strict
 *     binary. `failedHarness` is true whenever `status==="error"`, an `error` message is
 *     present, OR `ready===false` — so a backend `status:"applying"` (still starting up)
 *     collapses onto the SAME `"error"` readiness as a hard auth failure. The type
 *     `HarnessReadiness` (`src/session-client/harness/selection.ts:11`) also declares a
 *     `"polling"` member, and `AgentHarnessSelector`'s `isPolling()`
 *     (`agent-harness-selector.tsx:125`) and the composer's `harnessPending()`
 *     (`src/session-client/composer/composer.tsx:202-206`) both gate on
 *     `readiness === "polling"` — but nothing in the local harness store, switcher,
 *     hydrator, or status-actions module ever assigns that value (grepped; zero hits
 *     outside the type declaration). See BEHAVIORS #6 / INVARIANTS for the consequence.
 *   - Pi is a fixed-model harness (`fixedHarnessModel("pi")` returns
 *     `{id:"virtual", name:"Virtual", provider:{id:"pi"}}`,
 *     `src/session-client/harness/profile.ts:42`); `harnessHasConfigOptions("pi")` is
 *     `false`, so switching to Pi never fetches `/harness/options`, and
 *     `harnessReadyForSubmit` (`selection.ts:65-70`) short-circuits to `true` for any
 *     harness with a fixed model — Pi is never gated on config/auth readiness.
 *   - Abort capability — `PromptSubmitControl`'s busy icon/behavior is driven by
 *     `stoppable = working() && canAbort()` (`src/components/prompt-input/
 *     submit-ui-state.ts:18`), where `canAbort` is the session's
 *     `capabilities().abort` (`src/pages/session.tsx:1513`, from
 *     `GET /session/:id/capabilities`). If `abort` is `false`, a busy turn's submit
 *     control is `disabled` whenever the composer is blank
 *     (`submitDisabled` = `... || (!stoppable() && blank())`,
 *     `src/session-client/composer/composer.tsx:763-770`) — it can neither stop the
 *     turn (no abort capability) nor send a new one (still busy).
 *
 * ANATOMY —
 *   `[data-action="prompt-model"]` — the plain-OpenCode model control; renders only
 *     when `!harnessMode` (`src/components/prompt-input/model-control.tsx:40`).
 *   `[data-action="prompt-harness-model"]` — the harness model control (inside
 *     `AgentHarnessSelector`); renders only when `selection().isHarnessMode`
 *     (`harness !== "opencode"`) — text is the resolved model name, "Loading models",
 *     "Unavailable", or "Select model" depending on state
 *     (`agent-harness-selector.tsx:199-206`).
 *   Harness `<Select>` trigger — a button showing the current harness's display label
 *     ("OpenCode", "Claude", "Codex", "Cursor", "Pi" — `HARNESS_DISPLAY_NAMES` /
 *     `HARNESS_OPTION_LABELS`, `agent-harness-selector.tsx:10-33`); `disabled` once
 *     `sessionLocked()` is true. ACP and native-SDK variants of the same provider share
 *     a label ("Claude" for both `claude-acp` and `claude-sdk`) but render in different
 *     `<Select>` groups ("ACP" vs "Native SDK") — see HARNESS NOTES for disambiguation.
 *   `[title="Agent runtime unreachable after timeout"]` — the red-dot "Unavailable"
 *     readiness indicator, shown when `isError()` (`readiness === "error"`)
 *     (`agent-harness-selector.tsx:273-281`).
 *   `[title="Connecting to agent runtime..."]` — the pulsing-dot "Connecting" pill,
 *     shown when `isPolling()` (`readiness === "polling"`) — see BEHAVIORS #6, currently
 *     unreachable.
 *   `[aria-label="<configError message>"]` — the model-issue warning/error tooltip
 *     glyph next to the harness model control (`agent-harness-selector.tsx:311-330`).
 *   `[data-action="prompt-attach"]` — the attachment button; `disabled` while
 *     `harnessPending()` (`src/components/prompt-input/toolbar-controls.tsx:67`).
 *   `[role="textbox"]` composer editor — `contenteditable="false"` and
 *     `aria-disabled="true"` while `harnessPending()`
 *     (`src/components/prompt-input/frame.tsx:196-197`).
 *   `[data-action="prompt-submit"]` — submit/stop control; `data-icon="stop"` only
 *     while `stoppable()` (`working() && canAbort()`); `disabled` per
 *     `submitDisabled` above.
 *
 * BEHAVIORS —
 *   1. Exactly one model control exists in the DOM at any time: `[data-action=
 *      "prompt-model"]` while the draft harness is `opencode` (the default), or
 *      `[data-action="prompt-harness-model"]` once any other harness is selected —
 *      never both.
 *   2. For each configurable harness (`claude-acp`, `claude-sdk`, `codex-acp`,
 *      `codex-app-server`, `cursor-acp`, `cursor-sdk`): a workspace whose backend
 *      already reports that harness auto-hydrates the draft harness `<Select>` to its
 *      label and resolves its model in the harness model control (no click needed —
 *      see STATE MODEL path (b)), and that harness owns the submit payload's
 *      `providerID`/`modelID`/`agent` through draft hydration → first send → a second
 *      send → reload → a third send. Behavior 1's test separately proves the
 *      complementary manual-switch path (a).
 *   3. Once a session exists (any message sent), the harness `<Select>` is disabled —
 *      the harness cannot be changed mid-session.
 *   4. Pi is a fixed-model harness: a workspace hydrated onto it issues zero
 *      `/api/claxedo/agent-config/harness/options` requests, its readiness resolves to
 *      ready without ever showing the "Unavailable" indicator, submission is never
 *      gated on it, and the submitted payload carries `providerID: "pi"`,
 *      `modelID: "virtual"`.
 *   5. A workspace hydrated onto an unavailable/auth-error harness renders the red
 *      "Unavailable" indicator with its error message in a tooltip, keeps the submit
 *      control disabled, and sends zero session/prompt requests even after the user
 *      types and attempts to submit — and the plain-OpenCode model control
 *      (`[data-action="prompt-model"]`) never reappears as a silent fallback. FIXED:
 *      a fresh draft used to never even reach this state — `applyStatus`
 *      (`src/claxedo-ui/harness/harness-status-actions.ts`) silently dropped the
 *      failed-harness status against the store's seeded "opencode" placeholder
 *      (indistinguishable from a real user-confirmed selection), so the draft stayed
 *      on OpenCode instead of ever showing Claude/red-dot/etc. The guard now also
 *      requires `current.harness !== "opencode"`, which correctly limits protection
 *      to a genuinely confirmed non-opencode harness since "opencode" is the only
 *      value a fresh, never-confirmed scope can seed.
 *   6. [Currently unreachable — see STATE MODEL] readiness never resolves to
 *      `"polling"` for a local harness, so the "Connecting" pill, the composer's
 *      contenteditable lock, and the attach-button disable that are gated on it never
 *      fire; an in-progress ("applying") backend status is indistinguishable from a
 *      hard failure and renders the SAME "Unavailable" indicator instead.
 *   7. When the session's `abort` capability is `false`, a busy turn's submit control
 *      is disabled while the composer is blank (it can neither stop nor send).
 *   8. A `stale:true` model-options response that still carries a model list is applied
 *      immediately (the model control shows the resolved model, not "Select model" or
 *      "Loading"); the scheduled retry's eventual non-stale response does not change or
 *      clear that already-resolved selection.
 *   9. [Out of scope locally — see OUT OF SCOPE] a draft harness resets to `opencode`
 *      when the directory changes away from a workspace-runtime ref
 *      (`shouldResetWorkspaceDraftHarness`, `src/session-client/harness/
 *      store-policy.ts:80-92`) — that ref only exists for cloud/user-hosted
 *      workspaces (`sessionWorkspaceRuntimeRef`,
 *      `src/shell/workspace/session-workspace-key.ts:20-35`), which this local-only
 *      spec's mock cannot produce.
 *
 * INVARIANTS — harness ownership (#1 in e2e/INVARIANTS.md): the selected harness owns
 *   model/effort/payload at every stage, exactly one model control exists at a time, a
 *   harness is locked once the session is created, nothing silently falls back to
 *   plain OpenCode (#3). Submit gating (#4): the submit control's `data-icon`/`disabled`
 *   state is the single source of truth — every wait below is a deterministic
 *   DOM/request-count assertion, never a bare `waitForTimeout`.
 *
 * HARNESS NOTES — `claude-acp`/`claude-sdk`, `codex-acp`/`codex-app-server`, and
 *   `cursor-acp`/`cursor-sdk` each render under the SAME visible label ("Claude" /
 *   "Codex" / "Cursor" respectively) in different `<Select>` groups ("ACP" appears
 *   before "Native SDK" in `HARNESS_OPTIONS`'s array order,
 *   `agent-harness-selector.tsx:12`) — since the matrix cases auto-hydrate (STATE MODEL
 *   path (b)) rather than click through the `<Select>`, this spec disambiguates them
 *   purely by asserting the submit payload's `providerID`, never by label text alone
 *   (label text alone cannot tell `claude-acp` from `claude-sdk`). Behavior 1's test,
 *   which DOES click through the `<Select>` (path (a)), disambiguates by option index
 *   instead (ACP variant = 1st match, native-SDK variant = 2nd match). Pi and OpenCode
 *   share the "Direct" group but have unique labels ("Pi", "OpenCode"). See STATE MODEL
 *   for the dead "polling" readiness value shared by all harnesses uniformly (not
 *   harness-specific).
 *
 * OUT OF SCOPE — model/effort/variant selection mechanics and the multi-agent selector
 *   (`core-model-effort-agent-controls`); busy/thinking/escalation UI and
 *   retry/error-card rendering (`core-busy-abort-errors`); the same matrix replayed
 *   over the cloud relay (`core-harness-ownership-cloud`); per-harness event/tool
 *   rendering fidelity (`core-harness-rendering-matrix`); the workspace-runtime-ref
 *   draft-reset behavior (behavior #9 above — needs a cloud/user-hosted workspace,
 *   `core-harness-ownership-cloud`).
 */
import { expect, test, type Locator, type Page } from "@playwright/test"
import { installMockRuntime, type Harness } from "../helpers/mock-runtime"
import { expectAssistantReplyVisible, expectTurnCounts, expectNoDuplicateRows, SELECTORS } from "../helpers/turn-oracle"

const DIR = "/tmp/e2e-core-harness-ownership-local"

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

async function seedOneProject(page: Page, dir: string) {
  await page.addInitScript((d: string) => {
    localStorage.clear()
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
  await page.getByRole("button", { name: /^OpenCode$/ }).last().click()
  await page.getByRole("option", { name: optionName }).nth(optionIndex).click()
}

async function expectOnlyHarnessModelControl(page: Page, modelName: string | RegExp) {
  await expect(page.locator('[data-action="prompt-harness-model"]').last()).toContainText(modelName, { timeout: 20_000 })
  await expect(page.locator('[data-action="prompt-model"]')).toHaveCount(0)
}

/**
 * When `installMockRuntime` is seeded with a non-`opencode` `harness`, the draft
 * auto-adopts it on mount — `AgentHarnessSelector`'s effect calls `hydrate()`
 * (`src/claxedo-ui/context/harness-hydrator.ts:105-124`), which GETs
 * `/api/claxedo/agent-config/harness` and applies whatever the backend reports as
 * "current" — the SAME fixed harness the mock was installed with, regardless of any
 * client-side default. No user click is needed or (for these scenarios) possible: by
 * the time the draft renders, the harness Select trigger already reads the target
 * harness's label, not "OpenCode". This helper waits for that auto-hydration.
 */
async function expectHarnessAutoHydrated(page: Page, optionLabel: RegExp) {
  await expect(page.getByRole("button", { name: optionLabel }).last()).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole("button", { name: /^OpenCode$/ })).toHaveCount(0)
}

async function expectOnlyOpenCodeModelControl(page: Page) {
  await expect(page.locator('[data-action="prompt-model"]')).toHaveCount(1)
  await expect(page.locator('[data-action="prompt-harness-model"]')).toHaveCount(0)
}

test.describe("core harness ownership (local) @core", () => {
  // The harness matrix drives several sends + a reload per scenario, and this shared
  // dev server runs under heavy concurrent load from other e2e sessions — give every
  // test in this file headroom above the default so a slow (not stuck) navigation
  // doesn't fail the whole scenario. This is a per-file timeout bump, not a weakened
  // assertion — every wait inside the tests is still a deterministic poll/expect.
  test.beforeEach(async ({}, testInfo) => {
    testInfo.setTimeout(120_000)
  })

  test("draft starts on OpenCode's model control and switching harness swaps it for exactly one harness control — behavior 1", async ({
    page,
  }) => {
    await seedOneProject(page, DIR)
    await installMockRuntime(page, { dir: DIR, sessionId: "ses_core_harness_exclusive", harness: "opencode" })

    await openDraftPrompt(page, DIR)
    await expectOnlyOpenCodeModelControl(page)

    await switchDraftHarness(page, /^Claude$/, 0)
    await expectOnlyHarnessModelControl(page, /Sonnet 4\.6|claude-sonnet-4-6/i)

    // Never both at once, and never zero once a harness is picked.
    await expect(page.locator('[data-action="prompt-model"]')).toHaveCount(0)
    await expect(page.locator('[data-action="prompt-harness-model"]')).toHaveCount(1)
  })

  for (const harnessCase of [
    {
      harness: "claude-acp" as Harness,
      label: "Claude ACP",
      option: /^Claude$/,
      optionIndex: 0,
      modelLabel: /Sonnet 4\.6|claude-sonnet-4-6/i,
      providerID: "claude-acp",
      modelID: "claude-sonnet-4-6",
    },
    {
      harness: "claude-sdk" as Harness,
      label: "Claude SDK",
      option: /^Claude$/,
      optionIndex: 1,
      modelLabel: /Sonnet 4\.6|claude-sonnet-4-6/i,
      providerID: "claude-sdk",
      modelID: "claude-sonnet-4-6",
    },
    {
      harness: "codex-acp" as Harness,
      label: "Codex ACP",
      option: /^Codex$/,
      optionIndex: 0,
      modelLabel: /GPT-5\.2 Codex|gpt-5\.2-codex/i,
      providerID: "codex-acp",
      modelID: "gpt-5.2-codex",
    },
    {
      harness: "codex-app-server" as Harness,
      label: "Codex Native SDK",
      option: /^Codex$/,
      optionIndex: 1,
      modelLabel: /GPT-5\.5|gpt-5\.5/i,
      providerID: "codex-app-server",
      modelID: "gpt-5.5",
    },
    {
      harness: "cursor-acp" as Harness,
      label: "Cursor ACP",
      option: /^Cursor$/,
      optionIndex: 0,
      modelLabel: /Cursor Auto|cursor-auto/i,
      providerID: "cursor-acp",
      modelID: "cursor-auto",
    },
    {
      harness: "cursor-sdk" as Harness,
      label: "Cursor SDK",
      option: /^Cursor$/,
      optionIndex: 1,
      modelLabel: /Cursor Auto|cursor-auto/i,
      providerID: "cursor-sdk",
      modelID: "cursor-auto",
    },
  ] as const) {
    test(`${harnessCase.label} owns harness label, model, and payload through draft, sends, and reload; locked after creation — behaviors 1,2,3`, async ({
      page,
    }) => {
      const sessionId = `ses_core_harness_${harnessCase.harness.replace(/[^a-z0-9]/g, "_")}`
      const mock = await installMockRuntime(page, { dir: DIR, sessionId, harness: harnessCase.harness })

      await seedOneProject(page, DIR)
      const input = await openDraftPrompt(page, DIR)

      // This workspace's harness is already configured server-side (the mock is
      // seeded with it) — the draft auto-hydrates into it on mount, no click needed.
      // See `expectHarnessAutoHydrated`'s doc comment.
      await expectHarnessAutoHydrated(page, harnessCase.option)
      await expectOnlyHarnessModelControl(page, harnessCase.modelLabel)

      // Harness Select is still interactive pre-send.
      await expect(page.getByRole("button", { name: harnessCase.option }).last()).toBeEnabled()

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

      // Behavior 3: harness Select is locked now that the session exists.
      await expect(page.getByRole("button", { name: harnessCase.option }).last()).toBeDisabled()

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
      await expect(page.getByRole("button", { name: harnessCase.option }).last()).toBeDisabled()

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

  test("Pi is a fixed-model harness: zero options requests, instantly ready, payload owned by pi/virtual — behavior 4", async ({
    page,
  }) => {
    const sessionId = "ses_core_harness_pi"
    const mock = await installMockRuntime(page, { dir: DIR, sessionId, harness: "pi" })

    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    // Same auto-hydration as the matrix cases — see expectHarnessAutoHydrated's doc.
    await expectHarnessAutoHydrated(page, /^Pi$/)
    // No polling/error indicator ever appears for a fixed-model harness.
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
      modelID: "virtual",
    })
    await expect(page).toHaveURL(sessionUrlPattern(sessionId), { timeout: 20_000 })
    await expectAssistantReplyVisible(page, `ack 1: ${first}`)

    // Zero config-options requests for the entire scenario — pi has no config options.
    expect(mock.requests.harnessOptionsCount).toBe(0)
  })

  test(
    "unavailable/auth-error harness shows the red dot, blocks submit, sends zero requests, never falls back to OpenCode — behavior 5",
    async ({ page }) => {
      // FIXED: `applyStatus` (src/claxedo-ui/harness/harness-status-actions.ts)
      // used to guard `current?.harness && want !== current.harness` — since
      // `hydrate()` seeds the store to the placeholder `{harness: "opencode"}`
      // BEFORE fetching status (src/claxedo-ui/harness/harness-hydrator.ts:90,
      // `initialHarnessStoreState`/`initialHarness`,
      // src/session-client/harness/store-state.ts:40-44 +
      // store-policy.ts:31-34), that seed was indistinguishable from a real,
      // user-confirmed non-opencode selection, so a fresh draft's failed-harness
      // status was silently dropped and the draft stayed on OpenCode forever.
      // The guard now also requires `current.harness !== "opencode"` — the seed
      // is the ONLY state a fresh scope with no saved preference can carry, so
      // this correctly limits protection to a genuinely confirmed non-opencode
      // harness while still applying a failed status over the seeded
      // placeholder (see harness-status-actions.test.ts "applies a failed
      // harness status over the seeded opencode placeholder so the error
      // surfaces" and store-state.test.ts "seeds a fresh scope with the
      // un-confirmed opencode placeholder").
      const errorMessage = "claude binary not found"
      const mock = await installMockRuntime(page, {
        dir: DIR,
        sessionId: "ses_core_harness_unavailable",
        harness: "claude-acp",
        harnessReadiness: "error",
        harnessReadinessError: errorMessage,
      })

      await seedOneProject(page, DIR)
      const input = await openDraftPrompt(page, DIR)

      // Auto-hydrates onto the actually-configured (failing) harness — see
      // expectHarnessAutoHydrated's doc — instead of silently staying on the
      // seeded "OpenCode" placeholder.
      await expectHarnessAutoHydrated(page, /^Claude$/)

      // Red-dot "Unavailable" readiness indicator, never the "Connecting" pill.
      await expect(page.locator('[title="Agent runtime unreachable after timeout"]')).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('[title="Connecting to agent runtime..."]')).toHaveCount(0)

      // The error message surfaces in the model-issue tooltip glyph.
      await expect(page.locator(`[aria-label="${errorMessage}"]`)).toBeVisible()

      // Submit stays disabled (gated on the harness model control, not the
      // plain-OpenCode one) even after the user types and attempts to submit.
      await composePrompt(page, input, "core harness unavailable attempt")
      await expect(page.locator(SELECTORS.submitControl).last()).toBeDisabled()
      await page.locator(SELECTORS.submitControl).last().click({ force: true }).catch(() => {})

      // Never silently falls back to plain OpenCode.
      await expect(page.locator('[data-action="prompt-model"]')).toHaveCount(0)
      await expect(page.locator('[data-action="prompt-harness-model"]')).toHaveCount(1)
      await expect(page.getByRole("button", { name: /^OpenCode$/ })).toHaveCount(0)

      // Zero session/prompt requests were ever sent.
      expect(mock.requests.promptCount).toBe(0)
      expect(mock.requests.createSessionCount).toBe(0)
    },
  )

  test(
    "Connecting pill + composer fade + attach-disabled while readiness is polling — behavior 6",
    async ({ page }) => {
      // Fixed in Wave 2 (WP-B9): `harnessStatusPatch`
      // (src/session-client/harness/store-state.ts) now maps a non-opencode
      // harness reporting `ready:false` without a hard failure (backend
      // `status:"applying"`, i.e. still starting up) to readiness "polling"
      // during a startup/in-flight probe — distinct from the hard-failure
      // "error" state (which requires an error status/message or a *settled*
      // completed switch response). So the selector renders the pulsing
      // "Connecting" pill instead of the red "Unavailable" dot.
      const mock = await installMockRuntime(page, {
        dir: DIR,
        sessionId: "ses_core_harness_polling",
        harness: "claude-acp",
        harnessReadiness: "polling",
        // Keep the harness in the "applying" window for the whole assertion so
        // the polling state is stable (it never flips to ready mid-test).
        harnessPollingTurns: 1000,
      })

      await seedOneProject(page, DIR)
      // While the harness is polling, the composer is intentionally FADED and
      // non-editable — `harnessPending()` (true exactly when
      // `harnessReadiness(scope) === "polling"`,
      // src/session-client/composer/composer.tsx:204-208) drives
      // `contenteditable="false"` / `aria-disabled="true"` on the editor
      // (src/components/prompt-input/frame.tsx:222-223) and a 0.45 opacity fade.
      // That non-editable fade IS the contract this behavior asserts, so it must
      // NOT be opened via the shared `openDraftPrompt` helper — that helper
      // encodes the READY-harness contract (`contenteditable="true"`) and would
      // (correctly) reject the faded composer. Navigate inline and assert the
      // faded/disabled state directly instead.
      await page.goto(`/${slug(DIR)}/session`)
      await page.waitForLoadState("domcontentloaded")
      await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
      const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
      await expect(input).toBeVisible({ timeout: 20_000 })

      // Auto-hydrates onto the configured (still-connecting) harness.
      await expectHarnessAutoHydrated(page, /^Claude$/)

      // The "Connecting" pill is shown while polling — never the red
      // "Unavailable" dot, which is reserved for a hard/settled failure.
      await expect(page.locator('[title="Connecting to agent runtime..."]')).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('[title="Agent runtime unreachable after timeout"]')).toHaveCount(0)

      // Composer fade: the editor is dimmed and non-editable while connecting, so
      // the user cannot compose at all — a strictly stronger guarantee than
      // "typed text is rejected". Submit stays disabled on top of that.
      await expect(input).toHaveAttribute("contenteditable", "false")
      await expect(input).toHaveAttribute("aria-disabled", "true")
      await expect(page.locator(SELECTORS.submitControl).last()).toBeDisabled()

      // Never silently falls back to plain OpenCode, and no requests are sent.
      await expect(page.getByRole("button", { name: /^OpenCode$/ })).toHaveCount(0)
      expect(mock.requests.promptCount).toBe(0)
      expect(mock.requests.createSessionCount).toBe(0)
    },
  )

  test("session busy with abort capability false disables submit while the composer is blank — behavior 7", async ({
    page,
  }) => {
    const sessionId = "ses_core_harness_no_abort"
    const mock = await installMockRuntime(page, {
      dir: DIR,
      sessionId,
      harness: "opencode",
      timingsMs: { idle: 3_000 },
    })
    // Override AFTER installMockRuntime so this route wins (Playwright matches the
    // most-recently-registered handler first) — same session, abort capability off.
    await page.route("**/session/*/capabilities**", (route) => {
      const type = route.request().resourceType()
      if (type !== "fetch" && type !== "xhr") return route.continue()
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          transport: "opencode",
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
    await page.locator(SELECTORS.submitControl).last().click()
    await expect.poll(() => mock.requests.promptCount, { timeout: 15_000 }).toBe(1)

    // The optimistic send clears the composer, so it is blank while the mock holds
    // the turn busy for 3s (extended `idle` timing) — submit cannot show "stop"
    // (no abort capability) and cannot send (still busy), so it is disabled.
    const submit = page.locator(SELECTORS.submitControl).last()
    await expect(submit).toBeDisabled({ timeout: 10_000 })
    await expect(submit).not.toHaveAttribute("data-icon", "stop")

    // The turn still completes and the oracle still proves the reply once idle
    // finally arrives (busy-with-no-abort is not a stuck state). Once idle, submit
    // stays disabled — the composer is still blank, and `submitDisabled` (composer.tsx
    // :763-770) is `... || (!stoppable() && blank())`: this is the universal
    // can't-send-nothing rule that applies regardless of the abort capability, not
    // something specific to this scenario. The genuine proof that the no-abort busy
    // state was never a stuck lockout is that the composer becomes usable again once
    // there is something to send.
    await expectAssistantReplyVisible(page, `ack 1: ${text}`)
    await expect(submit).toBeDisabled({ timeout: 10_000 })
    await composePrompt(page, page.getByRole("textbox", { name: /Ask anything/i }).last(), "follow-up after idle")
    await expect(submit).toBeEnabled({ timeout: 10_000 })
  })

  test("a stale, model-carrying options response does not clear the resolved model selection, and the retry does not change it — behavior 8", async ({
    page,
  }) => {
    const sessionId = "ses_core_harness_stale_options"
    const mock = await installMockRuntime(page, { dir: DIR, sessionId, harness: "claude-acp" })

    let optionsCalls = 0
    await page.route("**/api/claxedo/agent-config/harness/options**", (route) => {
      const type = route.request().resourceType()
      if (type !== "fetch" && type !== "xhr") return route.continue()
      optionsCalls += 1
      const stale = optionsCalls === 1 // first response is stale but still carries the model
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

    // Same auto-hydration as the matrix cases (see expectHarnessAutoHydrated's doc) —
    // `applyStatus`'s hydrate path (src/claxedo-ui/context/harness-status-actions.ts:
    // 63-76) calls `fetchConfigOptions` too, so the stale-response route below is
    // exercised by the auto-hydrate itself, no manual click required.
    await expectHarnessAutoHydrated(page, /^Claude$/)

    // Behavior 8a: the stale-but-populated first response resolves the model
    // immediately — never a "Select model" placeholder in between.
    await expect(page.locator('[data-action="prompt-harness-model"]').last()).toContainText(/Sonnet 4\.6/i, {
      timeout: 5_000,
    })

    // The scheduled retry (1000ms backoff, see options-loader.ts) delivers the
    // non-stale confirmation — assert it actually happened and the selection is
    // unchanged afterward, never dropped or reset during the retry window.
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

  test.fixme(
    "draft harness resets to OpenCode when directory changes away from a workspace-runtime ref — behavior 9",
    async () => {
      // Not implementable in this local-only spec: `shouldResetWorkspaceDraftHarness`
      // (src/session-client/harness/store-policy.ts:80-92) only fires when
      // `harnessWorkspaceRuntimeRef` resolves truthy, which requires
      // `sessionWorkspaceRuntimeRef` to see a `cloud`/`user-hosted` backing
      // (src/shell/workspace/session-workspace-key.ts:20-35) — a plain local
      // directory never produces one. `installMockRuntime`'s local route set has
      // no notion of a workspace-runtime ref at all. This transition (cloud/
      // user-hosted directory -> local directory) belongs to
      // `core-harness-ownership-cloud` (spec 12), which mounts the relay-origin
      // `/api/wr/*` routes this behavior depends on.
    },
  )
})
