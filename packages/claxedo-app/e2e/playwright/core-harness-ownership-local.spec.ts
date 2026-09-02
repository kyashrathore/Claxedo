/**
 * SPEC: Local session harness ownership (the harness matrix)
 *
 * PURPOSE — a local session can run on one of several agent "harnesses" instead of
 * plain OpenCode: Claude and Codex each via an ACP subprocess or a native SDK
 * integration, Cursor via ACP or its native SDK, and Pi with provider-backed models.
 * Whichever harness is selected must own the session's model, agent, and
 * submit payload end to end — a user picking "Claude" must never have their prompt
 * silently routed through plain OpenCode, and switching harnesses must never leave two
 * conflicting model pickers on screen at once.
 *
 * STATE MODEL — the live harness selection is TRANSIENT, held in a client-local
 * `harnessStore` (`src/features/session/harness/harness-store.ts`) keyed by a
 * pane-preference `scope` string
 * (`panePreferenceScope({directory, sessionId, surfaceId, draftId})`,
 * `src/features/session/preferences/pane.ts`). Nothing is persisted per SCOPE. What
 * a NEW draft remembers is owned solely by the per-harness draft default
 * (`createDraftDefaultPreferences`, `src/features/session/harness/draft-defaults.ts`):
 * ONE record per (server, workspaceKey), stored under
 * `Persist.serverWorkspace(serverUrl, workspaceKey, "session.draft-default.v1")`
 * (`src/platform/persistence/persist.ts:382-384`), holding `lastHarness` plus a
 * per-harness `{model, labels}` slot — so picking Codex and then Claude no longer
 * overwrites the Codex model. `harnessStore.rememberDraftHarness`/`rememberDraftModel`
 * write it; `beginDraftDefault` re-reads it and re-seeds the scope whenever the
 * scope's `workspaceKey` changes, which is also what isolates two workspaces' drafts
 * from each other. It is NOT part of the server session row while still a draft.
 * `AgentHarnessSelector` (`src/features/session/ui/controls/agent-harness-selector.tsx`)
 * reads/writes the store through a `HarnessSelectionController`
 * (`src/features/session/harness/controller.ts`).
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
 *   - Existing session: harness is LOCKED. The unified picker remains available for
 *     model inspection while its Harness section is disabled; nothing in this codebase
 *     migrates an existing session's backing harness.
 *   - Readiness — `harnessStatusPatch`
 *     (`src/features/session/harness/store-state.ts:103-148`) is NOT a binary. It
 *     resolves the 4-member `HarnessReadiness` union
 *     (`src/features/session/harness/selection.ts:10`) in this precedence order
 *     (`store-state.ts:130-136`):
 *       (a) `hardFailedHarness(data)` — `status === "error"` or an `error` message —
 *           => `"error"`;
 *       (b) else a NON-`opencode` harness reporting `ready === false` =>
 *           `"polling"` for a startup/in-flight hydration probe, but `"error"` when the
 *           frame is a *settled* completed switch response (`settled: true` is passed
 *           only from `harness-switcher.ts:206`, the posted-switch path);
 *       (c) else a non-`opencode` harness whose `harnessHealth.status` is
 *           `degraded`/`unavailable` => `"degraded"`;
 *       (d) else `"ready"`.
 *     `opencode` — the always-available local default — is never `"polling"` and never
 *     `"degraded"`. So a backend `status:"applying"` (still starting up) is DISTINCT
 *     from a hard auth failure: it renders the pulsing "Connecting" pill, not the red
 *     "Unavailable" notice row. `AgentHarnessSelector`'s `isPolling()`
 *     (`src/features/session/ui/controls/agent-harness-selector.tsx:214`), the
 *     composer's `harnessPending()` (`src/features/session/composer/composer.tsx:169-171`,
 *     which feeds `toolbar-controls.tsx`'s `addDisabled`), and `submitBlockReason`'s
 *     `harness-polling` block (`src/features/session/composer/submit-block-reason.ts:94`)
 *     all gate on `readiness === "polling"`. BEHAVIORS #6's test covers the pill
 *     (`isPolling`) and the submit block (`harness-polling`); the `+`-button disable that
 *     `harnessPending()` drives via `toolbar-controls.tsx`'s `addDisabled` is reachable
 *     but NOT asserted below — a genuine coverage gap, not a dead code path.
 *     `"polling"` is NOT a dead end: `watchHarnessReprobe`
 *     (`src/features/session/harness/harness-reprobe.ts`, wired at
 *     `agent-harness-selector.tsx:222`) drives a BOUNDED re-probe loop while readiness is
 *     `"polling"` — it clears the hydrator's per-scope "seen" stamp and re-hydrates on an
 *     interval until the harness settles, or gives up after a hard cap and transitions to
 *     "Unavailable" (never infinite, never silent). See BEHAVIORS #6 / #6b.
 *   - Pi reads provider/model choices from its Pi-scoped provider catalog. Switching
 *     to Pi never fetches `/harness/options`; submission waits for an exact connected
 *     provider/model pair selected by the user or the unambiguous default policy.
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
 *   `[data-action="prompt-harness-model"]` — the unified harness/model/effort control
 *     for OpenCode, ACP, native SDK, and Pi. Its text is the resolved model name,
 *     "Loading models",
 *     "No Pi models available", or "Select model" depending on state
 *     (`agent-harness-selector.tsx`, `modelLabel`). It names a model or says there is
 *     none; it never reports an error — that is the notice row's job.
 *     The popover's Harness section groups same-label ACP and native-SDK variants under
 *     distinct headings, and that section is disabled once `sessionLocked()` is true.
 *   `[data-component="composer-notice"]` — the composer's ONE error surface, a row
 *     that peeks above the project/worktree context row (`composer-notice.tsx`,
 *     published by `AgentHarnessSelector` via `resolveHarnessNotice`). Carries
 *     `data-notice` (which condition), `data-tone`, the message and the runtime's own
 *     detail text, and its own `[data-action="composer-notice-action"]` Retry. It
 *     replaced four separate widgets that used to sit inside the control row.
 *   `[title="Agent runtime unreachable after timeout"]` — the notice row in its
 *     `readiness === "error"` state; the title is kept byte-exact for these specs
 *     (`harness-notice.ts`).
 *   `[title="Connecting to agent runtime..."]` — the pulsing-dot "Connecting" pill,
 *     shown when `isPolling()` (`readiness === "polling"`) — still inline, because
 *     connecting is progress, not a fault. Covered by BEHAVIORS #6 / #6b.
 *   `[data-action="prompt-add"]` — the `+` trigger that opens the flat action menu;
 *     `disabled` while `harnessPending()` (`toolbar-controls.tsx#addDisabled`). The
 *     attachment entry itself is `[data-action="prompt-attach"]` INSIDE that menu.
 *   `[role="textbox"]` composer editor — UNCONDITIONALLY `contenteditable="true"`, and
 *     never carries `aria-disabled`, polling or not
 *     (`src/features/session/composer/ui/frame.tsx:245` — the only `contenteditable`
 *     write in the file, a literal). Per T5 §4 (`dev-docs/CLAXEDO_ERROR_PROPOSAL.md`)
 *     the composer gates the SUBMIT, not the typing: a dead-looking box teaches nothing.
 *     The editor is therefore not a signal for `harnessPending()`; the submit control is.
 *   `[data-action="prompt-submit"]` — submit/stop control; `data-icon="stop"` only
 *     while `stoppable()` (`working() && canAbort()`); `disabled` per
 *     `submitDisabled` above.
 *
 * BEHAVIORS —
 *   1. Exactly one unified `[data-action="prompt-harness-model"]` control owns harness,
 *      model, and effort selection for every harness.
 *   2. For each configurable harness (`claude-acp`, `claude-sdk`, `codex-acp`,
 *      `codex-app-server`, `cursor-acp`, `cursor-sdk`): a workspace whose backend
 *      already reports that harness auto-hydrates the draft harness `<Select>` to its
 *      label and resolves its model in the harness model control (no click needed —
 *      see STATE MODEL path (b)), and that harness owns the submit payload's
 *      `providerID`/`modelID`/`agent` through draft hydration → first send → a second
 *      send → reload → a third send. Behavior 1's test separately proves the
 *      complementary manual-switch path (a).
 *   3. Once a session exists, the unified picker's Harness section is disabled — the
 *      harness cannot be changed mid-session.
 *   4. Pi issues zero `/api/claxedo/agent-config/harness/options` requests, resolves a
 *      concrete model from its configured provider catalog, persists that exact pair
 *      for the next workspace draft, and submits the selected provider/model identity.
 *   5. A workspace hydrated onto an unavailable/auth-error harness renders exactly one
 *      notice row stating the failure and its error message in words, keeps the submit
 *      control disabled, and sends zero session/prompt requests even after the user
 *      types and attempts to submit — and the unified picker never changes to the
 *      OpenCode harness as a silent fallback. FIXED:
 *      a fresh draft used to never even reach this state — `applyStatus`
 *      (`src/claxedo-ui/harness/harness-status-actions.ts`) silently dropped the
 *      failed-harness status against the store's seeded "opencode" placeholder
 *      (indistinguishable from a real user-confirmed selection), so the draft stayed
 *      on OpenCode instead of ever showing Claude/the failure row/etc. The guard now also
 *      requires `current.harness !== "opencode"`, which correctly limits protection
 *      to a genuinely confirmed non-opencode harness since "opencode" is the only
 *      value a fresh, never-confirmed scope can seed.
 *   6. A non-`opencode` harness whose backend reports `ready:false` WITHOUT a hard
 *      failure (`status:"applying"`, i.e. still starting up) resolves readiness to
 *      `"polling"`, NOT `"error"` — so the pulsing `[title="Connecting to agent
 *      runtime..."]` pill renders and the `[title="Agent runtime unreachable after
 *      timeout"]` dot does not. While polling, the unified picker remains inspectable,
 *      the submit control is disabled, zero session/prompt requests are sent, and the
 *      harness never changes to OpenCode. The composer editor stays live and typeable.
 *   6b. `"polling"` is a transient state, not a dead end. Hydration is one-shot (the
 *      hydrator stamps a per-scope "seen" key and early-returns forever), so a harness
 *      that first answered `ready:false` would once have stayed on the "Connecting" pill
 *      FOREVER. `watchHarnessReprobe` (`src/features/session/harness/harness-reprobe.ts`,
 *      wired at `agent-harness-selector.tsx:222`) drives a BOUNDED re-probe while
 *      readiness is `"polling"`: it clears the seen stamp and re-hydrates on an interval
 *      until the harness settles — at which point the Connecting pill clears and the
 *      `<Select>`/submit unlock — or, after a hard cap, transitions to "Unavailable".
 *      Never infinite, never silent.
 *   7. When the session's `abort` capability is `false`, a busy turn's submit control
 *      is disabled while the composer is blank (it can neither stop nor send).
 *   8. A `stale:true` model-options response that still carries a model list is applied
 *      immediately (the model control shows the resolved model, not "Select model" or
 *      "Loading"); the scheduled retry's eventual non-stale response does not change or
 *      clear that already-resolved selection.
 *   9. There is NO draft-harness reset when the scope leaves a workspace-runtime-backed
 *      directory, and nothing in `src/` performs one (owner decision 27; see
 *      `core-harness-ownership-cloud.spec.ts`). Neither the old predicate
 *      `shouldResetWorkspaceDraftHarness` nor the reset action that briefly replaced it
 *      exists — do not re-cite either. Cross-workspace isolation is PER-WORKSPACE
 *      PERSISTENCE, not a reset hook: the draft default is keyed by
 *      (server, workspaceKey) under `session.draft-default.v1` (see STATE MODEL), so a
 *      different workspace reads a different record and falls back to `opencode` on its
 *      own while the first workspace's choice survives untouched. The workspace-runtime
 *      ref itself is read through `harnessWorkspaceRuntimeRef` /
 *      `refreshHarnessTypeForScope` (`store-policy.ts`) over `sessionWorkspaceRuntimeRef`
 *      (`src/platform/runtime/session-workspace.ts`), which only resolves for
 *      cloud/user-hosted workspaces — which this local-only spec's mock cannot produce,
 *      so that ref path stays exercised only by the cloud spec.
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
 *   for the `"polling"`/`"degraded"` readiness values, which are computed uniformly for
 *   every non-`opencode` harness (not harness-specific) — `opencode` alone is exempt from
 *   both.
 *
 * OUT OF SCOPE — model/effort/variant selection mechanics and the multi-agent selector
 *   (`core-model-effort-agent-controls`); busy/thinking/escalation UI and
 *   retry/error-card rendering (`core-busy-abort-errors`); the same matrix replayed
 *   over the cloud relay (`core-harness-ownership-cloud`); per-harness event/tool
 *   rendering fidelity (`core-harness-rendering-matrix`); the workspace-runtime-ref
 *   cross-workspace draft isolation (behavior #9 above — needs a cloud/user-hosted
 *   workspace, `core-harness-ownership-cloud`).
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
    ;(window as typeof window & { __OPENCODE__?: { serverUrl?: string; activeDirectory?: string } }).__OPENCODE__ = {
      serverUrl: window.location.origin,
      activeDirectory: d,
    }
    if (sessionStorage.getItem("core-harness-seeded")) return
    sessionStorage.setItem("core-harness-seeded", "1")
    localStorage.clear()
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
  test.beforeEach(async ({}, testInfo) => {
    testInfo.setTimeout(120_000)
  })

  test("the unified picker owns OpenCode and harness model selection without duplicate controls — behavior 1", async ({
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

      // Behavior 3: harness Select is locked now that the session exists.
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
        view: { scope: "workspace", groupBy: "none", sort: "updated_desc", limit: 5 },
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
    // Start at home with a cold transient harness store, then let the rail warm
    // the existing transcript before clicking its row. That click starts the
    // production fast-switch network-quiet window; direct session URLs and
    // reloads never exercise it.
    await page.goto("/")
    await page.waitForLoadState("domcontentloaded")
    const row = page.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${sessionId}"]`).first()
    await expect(row).toBeVisible({ timeout: 20_000 })
    // Pin the exact branch independently of first-fold prefetch timing. The
    // rail owns this global and writes the same 2s values when its transcript
    // cache is warm; doing both in one browser task guarantees the session
    // composer mounts while that production quiet window is active.
    await row.evaluate((element, id) => {
      ;(element.querySelector("button") as HTMLButtonElement | null)?.click()
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
    await expect(restoredControl).toHaveAttribute("data-harness", "codex-app-server")
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

  test("Pi selects a configured provider model without harness options and owns the payload — behavior 4", async ({
    page,
  }) => {
    const sessionId = "ses_core_harness_pi"
    const mock = await installMockRuntime(page, { dir: DIR, sessionId, harness: "opencode" })

    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    await switchDraftHarness(page, /^Pi$/, 0)
    await expect(page.locator('[data-action="prompt-harness-model"][data-harness="pi"]').last()).toBeVisible({ timeout: 20_000 })
    await expectOnlyHarnessModelControl(page, /Virtual|virtual/i)
    await expect.poll(() => page.evaluate(() => Object.entries(localStorage)
      .find(([key]) => key.includes("session.draft-default.v1"))?.[1])).toContain('"harness":"pi"')
    // Pi obtains models from its provider catalog rather than harness config options.
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

    await page.goto(`/${slug(DIR)}/session`)
    await page.waitForLoadState("domcontentloaded")
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole("textbox", { name: /Ask anything/i }).last()).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-action="prompt-harness-model"][data-harness="pi"]').last()).toBeVisible({ timeout: 20_000 })
    await expectOnlyHarnessModelControl(page, /Virtual|virtual/i)

    // Zero config-options requests for the entire scenario — pi has no config options.
    expect(mock.requests.harnessOptionsCount).toBe(0)
  })

  test(
    "unavailable/auth-error harness shows one notice row, blocks submit, sends zero requests, never falls back to OpenCode — behavior 5",
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

      // The settled failure, never the "Connecting" pill.
      await expect(page.locator('[title="Agent runtime unreachable after timeout"]')).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('[title="Connecting to agent runtime..."]')).toHaveCount(0)

      // ONE surface reports it, above the project/worktree row. This used to be
      // four widgets side by side inside the control row — an "Unavailable"
      // readiness pill, the model trigger ALSO reading "Unavailable", an
      // unlabeled dot holding the only copy of the reason, and a loose Retry
      // button.
      const notice = page.locator("[data-component='composer-notice']")
      await expect(notice).toHaveCount(1)
      await expect(notice).toHaveAttribute("data-notice", "runtime-unavailable")
      await expect(notice).toHaveAttribute("data-tone", "critical")
      // The reason is readable without hovering anything.
      await expect(notice).toContainText("Claude runtime is unavailable")
      await expect(notice).toContainText(errorMessage)
      // Retry lives inside the row it explains.
      await expect(notice.locator("[data-action='composer-notice-action']")).toBeVisible()
      // The model control names a model or says there is none — it no longer
      // restates the error.
      await expect(page.locator('[data-action="prompt-harness-model"]')).not.toContainText("Unavailable")

      // SPEC UPDATED (T5, dev-docs/CLAXEDO_ERROR_PROPOSAL.md §B3/§T5, submit-block-
      // reason.ts): "Blocked ≠ disabled" — actionable reasons (including
      // `harness-error`) are never hard-`disabled` anymore; they stay clickable but
      // dimmed (`opacity-50`) and explain their refusal on intent/hover instead of
      // going silently dead. `harness-error` is in submit-block-reason.ts's
      // `ACTIONABLE` set, so the real gate here is `submitBlocked` inside the submit
      // handler (still hard-blocks the actual send), not the button's `disabled`
      // attribute.
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

      // Zero session/prompt requests were ever sent — the click flashed the
      // explain-on-intent tooltip but never actually submitted, since
      // `submitBlocked` (composer.tsx) still hard-gates the handler regardless of
      // the button's dim-but-clickable visual state.
      expect(mock.requests.promptCount).toBe(0)
      expect(mock.requests.createSessionCount).toBe(0)
    },
  )

  test(
    "Connecting keeps the unified picker inspectable while submit stays disabled and sends zero requests — behavior 6",
    async ({ page }) => {
      // Fixed in Wave 2 (WP-B9): `harnessStatusPatch`
      // (src/session-client/harness/store-state.ts) now maps a non-opencode
      // harness reporting `ready:false` without a hard failure (backend
      // `status:"applying"`, i.e. still starting up) to readiness "polling"
      // during a startup/in-flight probe — distinct from the hard-failure
      // "error" state (which requires an error status/message or a *settled*
      // completed switch response). So the selector renders the pulsing
      // "Connecting" pill instead of the settled "Unavailable" notice row.
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
      // SPEC UPDATED (T5 §4, dev-docs/CLAXEDO_ERROR_PROPOSAL.md; frame.tsx:239-241):
      // "keep the editor editable while the harness polls — gate the submit, not
      // the typing." The editor is UNCONDITIONALLY `contenteditable="true"` now (no
      // `aria-disabled` is ever set on it) — a dead-looking box teaches nothing, so
      // the composer stays a live, typeable peek even while connecting. What DOES
      // stay gated is the submit control (`harness-polling` is not actionable).
      // The unified picker remains enabled so its resolved harness/model state can
      // still be inspected while readiness catches up.
      await page.goto(`/${slug(DIR)}/session`)
      await page.waitForLoadState("domcontentloaded")
      await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
      const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
      await expect(input).toBeVisible({ timeout: 20_000 })

      // Auto-hydrates onto the configured (still-connecting) harness.
      await expectHarnessAutoHydrated(page, /^Claude$/)

      // The "Connecting" pill is shown while polling — never the red
      // "Unavailable" notice row, which is reserved for a hard/settled failure.
      await expect(page.locator('[title="Connecting to agent runtime..."]')).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('[title="Agent runtime unreachable after timeout"]')).toHaveCount(0)

      // The editor stays live and typeable, and the picker remains inspectable;
      // submit is the action that stays gated.
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
    // Title corrected 2026-07-25: dropped "composer unlocks" — the composer is never
    // locked (see ANATOMY); the pill clearing and the Select/submit unlocking are the
    // real settle signals.
    "a slow harness settles under the bounded re-probe loop: Connecting clears, readiness becomes ready, and submit unlocks — behavior 6b",
    async ({ page }) => {
      // The polling readiness used to be a DEAD-END: hydration is one-shot
      // (src/features/session/harness/harness-hydrator.ts stamps a per-scope "seen" key
      // and early-returns forever), and nothing re-applied harness status, so a
      // harness that first answered `ready:false` (backend `status:"applying"`)
      // stayed on the "Connecting" pill FOREVER. The fix
      // (src/features/session/harness/harness-reprobe.ts +
      // AgentHarnessSelector's `watchHarnessReprobe` wiring, agent-harness-selector.tsx:222)
      // drives a bounded
      // re-probe while readiness is "polling": it clears the seen stamp and
      // re-hydrates on an interval until the harness settles (or, after a hard
      // cap, transitions to "Unavailable" — never infinite, never silent).
      //
      // `harnessGetPollSettleAfter` makes the mock's harness-status GET flip to
      // ready after N GET probes — modelling exactly that slow-then-ready
      // harness. Behavior 6 (which omits this knob) stays permanently polling.
      const mock = await installMockRuntime(page, {
        dir: DIR,
        sessionId: "ses_core_harness_polling_settles",
        harness: "claude-acp",
        harnessReadiness: "polling",
        // Never settles via POST (there is no switch POST in this draft flow);
        // the ONLY settle path is the client's bounded GET re-probe loop.
        harnessPollingTurns: 1000,
        // Initial hydrate GET keeps it polling; a couple of re-probe GETs later
        // it flips to ready — proving the loop drives the harness to settle.
        harnessGetPollSettleAfter: 3,
      })

      await seedOneProject(page, DIR)

      // SPEC UPDATED (T5 §4 — see behavior 6's comment): the editor is always
      // `contenteditable="true"`, polling or not, so it can no longer serve as the
      // phase-1/phase-2 signal. Navigate inline anyway to assert the polling
      // contract directly without any intermediate ready-harness assumption.
      await page.goto(`/${slug(DIR)}/session`)
      await page.waitForLoadState("domcontentloaded")
      await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
      const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
      await expect(input).toBeVisible({ timeout: 20_000 })

      await expectHarnessAutoHydrated(page, /^Claude$/)
      const harnessTrigger = page.locator('[data-action="prompt-harness-model"]:visible').last()

      // Phase 1 — still connecting: pill shown, picker remains inspectable,
      // editor stays live/typeable, never the "Unavailable" notice row.
      await expect(page.locator('[title="Connecting to agent runtime..."]')).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('[title="Agent runtime unreachable after timeout"]')).toHaveCount(0)
      await expect(input).toHaveAttribute("contenteditable", "true")
      await expect(harnessTrigger).toBeEnabled()
      await expect(harnessTrigger).toHaveAttribute("data-readiness", "polling")

      // Phase 2 — the bounded re-probe loop drives the harness to settle: the
      // "Connecting" pill clears on its own (no user action, no reload), the
      // picker reports ready, and it never degrades to "Unavailable".
      await expect(page.locator('[title="Connecting to agent runtime..."]')).toHaveCount(0, { timeout: 30_000 })
      await expect(page.locator('[title="Agent runtime unreachable after timeout"]')).toHaveCount(0)
      await expect(harnessTrigger).toBeEnabled({ timeout: 10_000 })
      await expect(harnessTrigger).toHaveAttribute("data-readiness", "ready")

      // The harness model resolves and submit unlocks once the user types.
      await expectOnlyHarnessModelControl(page, /Sonnet 4\.6|claude-sonnet-4-6/i)
      await composePrompt(page, input, "core harness polling settled turn")
      await expect(page.locator(SELECTORS.submitControl).last()).toBeEnabled({ timeout: 10_000 })

      // And it actually sends on the now-settled harness.
      await page.locator(SELECTORS.submitControl).last().click()
      await expect.poll(() => mock.requests.promptCount, { timeout: 15_000 }).toBe(1)
      expect(mock.requests.promptBodies[0]).toMatchObject({
        text: "core harness polling settled turn",
        providerID: "claude-acp",
        modelID: "claude-sonnet-4-6",
      })
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
    await ensureComposerModelSelected(page, { modelName: /^Big Pickle$/i, search: "Big Pickle" })
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

  // Behavior 9 (owner decision 27): the draft harness auto-reset to OpenCode was
  // REMOVED — the embedded local runtime backs every harness, so a user's choice is
  // kept across navigation, never silently reset. Here we pin the persistence contract
  // at the local level: a non-OpenCode harness picked on a local draft survives a
  // same-pane reload. The workspace-runtime-ref transition that the old reset actually
  // guarded (`installMockRuntime`'s local routes have no workspace-runtime ref) is proven
  // red->green in `core-harness-ownership-cloud` behavior 5.
  test(
    "a non-OpenCode harness picked on a local draft persists across a same-pane reload — never reset to OpenCode — behavior 9",
    async ({ page }) => {
      await seedOneProject(page, DIR)
      await installMockRuntime(page, { dir: DIR, sessionId: "ses_core_harness_persist", harness: "opencode" })
      await openDraftPrompt(page, DIR)

      // Pick a non-OpenCode harness on the local draft.
      await switchDraftHarness(page, /^Claude$/, 0)
      await expectHarnessAutoHydrated(page, /^Claude$/)
      await expect
        .poll(() =>
          page.evaluate(
            () => Object.entries(localStorage).find(([key]) => key.includes("session.draft-default.v1"))?.[1],
          ),
        )
        .toContain('"harness":"claude')

      // Reload the same draft route — the selection is kept, never force-reset to OpenCode.
      await openDraftPrompt(page, DIR)
      await expectHarnessAutoHydrated(page, /^Claude$/)
    },
  )

  test(
    "switching harness re-reads status over GET, because the switch POST returns only {ok:true} — behavior 10",
    async ({ page }) => {
      // REGRESSION TEST for a real production bug, not a mock artifact.
      //
      // `POST /api/claxedo/agent-config/harness` answers `{ ok: true }` and nothing
      // else (claxedo-local-server/src/agent-config/routes/harness-routes.ts:202,211).
      // `postHarnessConfig` (src/features/session/harness/harness-switcher.ts) did:
      //
      //     decodeHarnessState(await res.json()) ?? await fetchHarnessStatus(...) ?? true
      //
      // `decodeHarnessState({ok:true})` finds no harness/status/binary keys and returns
      // an EMPTY OBJECT (profile.ts:84-99). `{}` is truthy, so `??` short-circuited and
      // `fetchHarnessStatus` — the fallback that exists for exactly this response —
      // could never run against a real server. `applyPostedStatus` then skipped its
      // patch because `failedHarness({})` is false, so a switch onto a broken harness
      // surfaced NO error at all.
      //
      // This was invisible for as long as it existed because the e2e fixture answered
      // the POST with a full harness-status payload, letting every harness spec watch a
      // switch settle straight off the POST — a path production cannot take. The mock
      // now returns the honest `{ok:true}`, and this test pins the GET that must follow.
      //
      // Distinct from behavior 5, which covers HYDRATION onto an already-failing
      // harness (status is known before any switch). This covers the SWITCH path.
      const mock = await installMockRuntime(page, {
        dir: DIR,
        sessionId: "ses_core_harness_switch_status",
        // "Claude" in the picker is the NATIVE claude-sdk row: first-party ACP
        // options left the picker when operator-configured ACP connections
        // became the ACP group (see agent-harness-selector BUILTIN_HARNESS_OPTIONS).
        harnessModels: { "claude-sdk": [{ id: "claude-sonnet-4-6", name: "Claude Sonnet" }] },
      })

      await seedOneProject(page, DIR)
      await openDraftPrompt(page, DIR)

      // `harnessPostCount` counts BOTH verbs on `/api/claxedo/agent-config/harness`:
      // `mock-runtime.ts:1368` increments it BEFORE the `method() === "POST"` check, and
      // says so at `mock-runtime.ts:166-173`. `harnessGetCount` (`mock-runtime.ts:1405`)
      // counts ONLY the GETs, so `harnessPostCount - harnessGetCount` is the true POST
      // count. A bare `harnessPostCount > 0` was VACUOUS here — the mount-time hydrate GET
      // in `openDraftPrompt` had already moved it, so that assertion could not fail even
      // if the switch POST were never issued at all.
      const getsBeforeSwitch = mock.requests.harnessGetCount
      const postsBeforeSwitch = mock.requests.harnessPostCount - mock.requests.harnessGetCount
      await switchDraftHarness(page, /^Claude$/, 0)
      await expectOnlyHarnessModelControl(page, /Claude Sonnet/)

      // The switch POST landed (GET-discriminated, per the note above)...
      await expect
        .poll(() => mock.requests.harnessPostCount - mock.requests.harnessGetCount, { timeout: 15_000 })
        .toBeGreaterThan(postsBeforeSwitch)
      // ...and a GET followed it. Before the fix this count never moved, because the
      // empty-but-truthy decode swallowed the fallback.
      await expect
        .poll(() => mock.requests.harnessGetCount, { timeout: 15_000 })
        .toBeGreaterThan(getsBeforeSwitch)
    },
  )
})
