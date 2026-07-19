/**
 * SPEC: Cloud/workspace-runtime session harness ownership (spec 3's matrix, over the relay)
 *
 * PURPOSE — a cloud (sandbox VM) or user-hosted workspace runs sessions through the
 * Claxedo control plane + Workspace Relay instead of the loopback OpenCode server. This
 * spec proves the SAME harness-ownership contract as `core-harness-ownership-local`
 * (spec 3) still holds once every request is routed through the workspace-scoped relay
 * lane (`/workspaces/:workspaceId/...`, same-origin path prefix, confirmed in
 * `core-cloud-provisioning.spec.ts`) — AND documents the parts of that contract that are
 * genuinely DIFFERENT for a relay-backed workspace: draft-time harness switching never
 * touches the local readiness-check endpoint, the model-options endpoint is a relay-only
 * route, and a draft pane that carries a non-OpenCode harness selection across a
 * navigation into a workspace-runtime directory has that selection forcibly reset — so a
 * cloud/user-hosted session can never silently inherit a harness/model chosen for a
 * different (local or other-workspace) scope.
 *
 * STATE MODEL — same client-local `harnessStore` as spec 3
 * (`src/claxedo-ui/context/harness-store.ts`, scope = `panePreferenceScope`), but the
 * runtime wiring diverges once `harnessWorkspaceRuntimeRef({directory})` resolves truthy
 * (`src/session-client/harness/store-policy.ts:76-78`, backed by
 * `sessionWorkspaceRuntimeRef` reading the SIGNED PROJECT INVENTORY's `workspaces[dir].kind`,
 * `src/shell/workspace/session-workspace-key.ts:20-65` — a directory only resolves
 * `"cloud"`/`"user-hosted"` when the inventory says so, never by guessing from shape):
 *   - `shouldUseLocalHarnessConfigApi` (`store-policy.ts:169-176`) is `false` whenever
 *     `workspaceKind` is `"cloud"` or `"user-hosted"` — regardless of transport.
 *   - Draft harness switch (`switchDraftHarness`,
 *     `src/claxedo-ui/context/harness-switcher.ts:77-98`): when `useLocalHarnessConfig`
 *     is true AND `workspace.kind` is NOT cloud/user-hosted, it POSTs
 *     `/api/claxedo/agent-config/harness` and uses the response's readiness (spec 3's
 *     path). For a cloud/user-hosted directory that POST is SKIPPED entirely —
 *     `status` is hardcoded `true` (`postHarnessConfig` is never called,
 *     harness-switcher.ts:84-87) — so a cloud/user-hosted draft's harness readiness is
 *     UNCONDITIONALLY "ready" the instant it is picked; there is no draft-time
 *     "Unavailable"/"Connecting" state to observe (see HARNESS NOTES).
 *   - Model options for a configurable harness (`claude-acp`, `claude-sdk`, `codex-acp`,
 *     `codex-app-server`, `cursor-acp`, `cursor-sdk`) come from a DIFFERENT endpoint once
 *     `harnessWorkspaceRuntimeRef` is truthy: `configOptionsFetch`
 *     (`src/claxedo-ui/context/harness-config-runtime.ts:126-146`) calls
 *     `workspaceHarnessTransport(params).fetch(workspaceRuntimeAgentConfigPath({resource:
 *     "api/wr/harness-config-options", directory, harnessType: type}))` instead of the
 *     local `/api/claxedo/agent-config/harness/options` — a relay request whose path is
 *     `/workspaces/:workspaceId/api/wr/harness-config-options?directory=...&harness=<type>`
 *     (`harness-config-routes.ts:41-50`, `transport.ts`'s `createTransport` +
 *     `workspace-runtime-request.ts:226` build the `/workspaces/:workspaceId` prefix).
 *   - Session create/prompt/message/config/capabilities for a relay-backed session go
 *     through the SAME session-client code as local, proxied by
 *     `workspaceHarnessTransport`/the session controller's own transport onto
 *     `/workspaces/:workspaceId/session...` — never the loopback `/session/...` paths
 *     directly (verified per-request below via the mock's path routing, not by trusting
 *     client code).
 *   - Cross-workspace leak guard: `shouldResetWorkspaceDraftHarness`
 *     (`store-policy.ts:80-92`) fires inside `createHarnessHydrator`'s `hydrate()`
 *     (`src/claxedo-ui/context/harness-hydrator.ts:89-100`) whenever the scope is still a
 *     draft, the CURRENT `directory` resolves a workspace-runtime ref (cloud/user-hosted),
 *     there is no session yet, and the scope's already-selected harness (from whatever it
 *     was set to before this hydrate call) is not `"opencode"` — it force-resets the
 *     scope's harness to `"opencode"`. The scope key is `panePreferenceScope` — when a
 *     stable `draftId` (the pane's `surfaceId`) is supplied, the scope is `draft:${draftId}`
 *     and does NOT change with `directory`
 *     (`src/pane/store/pane-preferences.ts:39-43`), so a SAME-PANE, same-tab, client-side
 *     navigation (Solid Router's `navigate()`, e.g. via the empty-draft header's project
 *     `<Select>`, `openProject` in `src/components/session/session-new-design-view.tsx`)
 *     from a local directory (harness already picked) into a workspace-runtime directory
 *     is exactly the carryover this guard exists to prevent — it is the mechanism behind
 *     "no local/OpenCode state leaks into cloud sessions" / "switching local↔cloud leaks
 *     nothing". `harness-preferences.ts`'s `save()` is a documented no-op ("new choices
 *     are persisted by session config", not per-scope localStorage) — so this in-memory
 *     reset is the ONLY guard against carryover; there is no separate persisted-storage
 *     isolation to fall back on.
 *
 * ANATOMY — same selectors as spec 3 (`[data-action="prompt-model"]`,
 *   `[data-action="prompt-harness-model"]`, the harness `<Select>` trigger/options, submit
 *   control) plus:
 *   - relay lane path prefix `/workspaces/<workspaceId>/...` — every session/prompt/
 *     message/config/capabilities/provider/harness-options request for a relay-backed
 *     session lands here, never on the bare `/session/...`/`/api/claxedo/...` paths.
 *   - `/workspaces/<workspaceId>/api/wr/harness-config-options?harness=<type>` — the
 *     relay's per-harness model-options endpoint (query-param scoped, see STATE MODEL).
 *   - the empty-draft header's project `<Select>` (only rendered pre-send,
 *     `session-new-design-view.tsx`, `!runtimeMode()`) — a `role="button"` trigger showing
 *     the current project's label and `role="option"` entries for every top-level project
 *     in the signed inventory (including a cloud workspace registered as its OWN
 *     top-level project row); selecting a different entry calls `navigate()` (client-side,
 *     no page reload) — the vehicle this spec uses to reproduce the same-pane
 *     local→cloud navigation the leak guard defends against.
 *
 * BEHAVIORS —
 *   1. For each configurable harness (`claude-acp`, `claude-sdk`, `codex-acp`,
 *      `codex-app-server`, `cursor-acp`, `cursor-sdk`): selecting it on a cloud
 *      workspace's draft resolves its model via the relay's
 *      `/api/wr/harness-config-options` endpoint (never the local
 *      `/api/claxedo/agent-config/harness/options` endpoint), and that harness owns the
 *      submit payload's `providerID`/`modelID`/`agent` through draft → first send
 *      (session create, relay lane) → reload → a second send — all dispatched through
 *      `/workspaces/:workspaceId/...`, never the bare `/session/...` paths. The harness
 *      `<Select>` is disabled once the session exists, identically to local.
 *   2. Pi uses its provider catalog on a cloud workspace, makes zero
 *      `/api/wr/harness-config-options` requests, and reuses the exact eligible
 *      OpenCode pair when that is the unambiguous configured choice.
 *   3. `/api/wr/harness-config-options` requests are scoped per harness: switching the
 *      draft harness selection re-issues the request with `harness=<the newly selected
 *      type>`, and the model resolved into `[data-action="prompt-harness-model"]` always
 *      matches THAT harness's catalog — never a stale/different harness's model left over
 *      from a prior selection.
 *   4. Selecting a configurable harness on a cloud workspace draft sends ZERO POSTs to the
 *      local `/api/claxedo/agent-config/harness` status endpoint — readiness resolves
 *      "ready" unconditionally pre-send (see HARNESS NOTES for the consequence).
 *   5. Picking a non-OpenCode harness while the draft pane's directory is a plain local
 *      project, then client-side-navigating (via the project `<Select>`, no page reload)
 *      that SAME pane to a cloud workspace's directory, resets the draft harness back to
 *      OpenCode BEFORE any cloud request is made: exactly one model control
 *      (`[data-action="prompt-model"]`) is present immediately after the navigation
 *      settles, and the prompt subsequently sent through the cloud workspace carries
 *      `providerID: "opencode"` — the local harness/model selection never reaches the
 *      relay lane.
 *
 * INVARIANTS — harness ownership (#1 in e2e/INVARIANTS.md): the selected harness owns
 *   model/effort/payload at every stage, exactly one model control exists at a time, a
 *   harness is locked once the session is created. No silent fallback (#3): the ONE
 *   fallback-to-OpenCode this spec exercises (behavior 5) is the INTENDED cross-workspace
 *   leak guard, not a failure-path fallback — it fires deterministically on navigation,
 *   before any request, never mid-turn. Submit gating (#4): every wait below is a
 *   deterministic DOM/request-count assertion, never a bare `waitForTimeout`.
 *
 * HARNESS NOTES — cloud/user-hosted drafts skip the local readiness POST/polling
 *   entirely (behavior 4) — so spec 3's "Unavailable" red-dot and "Connecting" pill
 *   pre-send states are structurally unreachable for a cloud DRAFT (not a bug: there is
 *   no backend call whose failure could produce them before a session exists). An
 *   ALREADY-CREATED cloud session's readiness still derives from
 *   `GET /session/:id/config` the same as local (`harnessStateFromSessionConfig`,
 *   harness-hydrator.ts:75) — re-verifying that path is spec 3-shaped and out of scope
 *   here.
 *
 * OUT OF SCOPE — the 4-step workspace-provisioning pipeline and reload-mid-provision
 *   resume (`core-cloud-provisioning`, spec 11); busy/thinking/escalation/abort UI
 *   (`core-busy-abort-errors`, spec 5); relay offline/403/viewer-role and the
 *   arm-once/reconnect contract (`core-cloud-offline-roles`, spec 13); the
 *   model/effort/variant/multi-agent selector mechanics themselves
 *   (`core-model-effort-agent-controls`, spec 4); per-harness event/tool rendering
 *   fidelity (`core-harness-rendering-matrix`, spec 10); user-hosted's distinct 3-step
 *   connect pipeline (`core-user-hosted-workspace`, spec 14) — this spec always uses
 *   `kind: "cloud"`, never `"user-hosted"`, for its workspace(s).
 *
 * MOCK — uses the shared `installMockRuntime`'s `cloud` option
 * (`e2e/helpers/mock-runtime.ts`), NOT a spec-local hand-rolled mock. The relay-lane
 * session/prompt/message/config/capabilities/provider/harness-config-options routes and
 * the connection mint (`GET /api/workspace/:workspaceId/connection`) this spec depends on
 * were ported into that shared helper from `core-cloud-provisioning.spec.ts`'s own
 * oracle-proven `installCloudRuntimeMock` — see the shared helper's own comment on its
 * `cloud` block for the exact route shapes and why they are mounted at
 * `${relayUrl}/workspaces/:workspaceId${path}` (the shape the app's own
 * `workspaceRelayConnection` follows, `src/utils/workspace-relay-connection.ts:352`).
 * Previously every `test()` below was `test.fixme()` behind a documented KNOWN GAP
 * (installMockRuntime's `cloud` catch-all did not model the session lane at all); that
 * gap is now closed and every behavior below runs for real.
 */
import { expect, test, type Page } from "@playwright/test"
import { expectAssistantReplyVisible, expectTurnCounts, SELECTORS } from "../helpers/turn-oracle"
import { installMockRuntime, type Harness } from "../helpers/mock-runtime"

const DIR = "/tmp/e2e-core-harness-ownership-cloud"
const PROJECT_ID = "proj_core_harness_cloud"
const PROJECT_NAME = "core-harness-cloud-local"
const WORKSPACE_ID = "ws_core_harness_cloud"
const WORKSPACE_PROJECT_NAME = "core-harness-cloud-workspace"
const RELAY_ORIGIN = "https://relay.core-harness-ownership-cloud.test"

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
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

function workspaceRoute(sessionId?: string) {
  return sessionId ? `/w/${encodeURIComponent(WORKSPACE_ID)}/session/${sessionId}` : `/w/${encodeURIComponent(WORKSPACE_ID)}/session`
}

function sessionUrlPattern(sessionId: string) {
  return new RegExp(`(?:/s/${sessionId}|/w/[^/]+/session/${sessionId})$`)
}

// `fromLabel` is the harness trigger's CURRENT accessible name — it defaults to
// "OpenCode" (the draft's initial state) but callers switching harness a second time
// in the same test must pass the label the trigger now carries (e.g. "Claude"), since
// the trigger's accessible name changes to whatever harness is currently selected.
async function switchDraftHarness(page: Page, optionName: RegExp, optionIndex: number, fromLabel: RegExp = /^OpenCode$/) {
  await page.getByRole("button", { name: fromLabel }).last().click()
  await page.getByRole("option", { name: optionName }).nth(optionIndex).click()
}

// `:visible` (not a bare count): a same-pane cross-workspace navigation (behavior
// 5) keeps the PRIOR pane's composer mounted-but-hidden behind the new one rather
// than unmounting it (confirmed via a live DOM probe — the stale node has a real,
// non-zero layout rect and is still `isConnected`, scoped to the old local
// directory) — a bare `toHaveCount` sees that stale node too and false-fails even
// though only one model control is ever user-visible at a time. `:visible` is
// Playwright's own CSS extension (real visibility, not DOM-order guesswork like
// `.last()`), so this stays exactly as strict for every other (single-pane) call
// site in this file.
async function expectOnlyHarnessModelControl(page: Page, modelName: string | RegExp) {
  await expect(page.locator('[data-action="prompt-harness-model"]:visible').last()).toContainText(modelName, { timeout: 20_000 })
  await expect(page.locator('[data-action="prompt-model"]:visible')).toHaveCount(0)
}

async function expectOnlyOpenCodeModelControl(page: Page) {
  await expect(page.locator('[data-action="prompt-model"]:visible')).toHaveCount(1, { timeout: 20_000 })
  await expect(page.locator('[data-action="prompt-harness-model"]:visible')).toHaveCount(0)
}

test.describe("core harness ownership (cloud) @core", () => {
  for (const harnessCase of [
    { harness: "claude-acp" as Harness, option: /^Claude$/, optionIndex: 0, modelLabel: /Sonnet 4\.6|claude-sonnet-4-6/i, providerID: "claude-acp", modelID: "claude-sonnet-4-6" },
    { harness: "claude-sdk" as Harness, option: /^Claude$/, optionIndex: 1, modelLabel: /Sonnet 4\.6|claude-sonnet-4-6/i, providerID: "claude-sdk", modelID: "claude-sonnet-4-6" },
    { harness: "codex-acp" as Harness, option: /^Codex$/, optionIndex: 0, modelLabel: /GPT-5\.2 Codex|gpt-5\.2-codex/i, providerID: "codex-acp", modelID: "gpt-5.2-codex" },
    { harness: "codex-app-server" as Harness, option: /^Codex$/, optionIndex: 1, modelLabel: /GPT-5\.5|gpt-5\.5/i, providerID: "codex-app-server", modelID: "gpt-5.5" },
    { harness: "cursor-acp" as Harness, option: /^Cursor$/, optionIndex: 0, modelLabel: /Cursor Auto|cursor-auto/i, providerID: "cursor-acp", modelID: "cursor-auto" },
    { harness: "cursor-sdk" as Harness, option: /^Cursor$/, optionIndex: 1, modelLabel: /Cursor Auto|cursor-auto/i, providerID: "cursor-sdk", modelID: "cursor-auto" },
  ] as const) {
    test(`${harnessCase.harness} owns harness label, model, and payload through cloud draft, sends, and reload over the relay; locked after creation — behavior 1`, async ({ page }) => {
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
      await expectOnlyOpenCodeModelControl(page)

      await switchDraftHarness(page, harnessCase.option, harnessCase.optionIndex)
      await expect(page.getByRole("button", { name: harnessCase.option }).last()).toBeVisible({ timeout: 20_000 })
      await expectOnlyHarnessModelControl(page, harnessCase.modelLabel)
      await expect(page.getByRole("button", { name: harnessCase.option }).last()).toBeEnabled()

      const first = `core harness cloud ${harnessCase.harness} first turn`
      await input.click()
      await input.fill(first)
      await expect(input).toContainText(first, { timeout: 10_000 })
      await page.locator(SELECTORS.submitControl).last().click()

      await expect.poll(() => mock.requests.cloudPromptCount, { timeout: 15_000 }).toBe(1)
      expect(mock.requests.cloudSessionCreateCount).toBe(1)
      expect(mock.requests.cloudPromptBodies[0]).toMatchObject({ text: first, providerID: harnessCase.providerID, modelID: harnessCase.modelID })
      await expect(page).toHaveURL(sessionUrlPattern(`ses_cloud_${WORKSPACE_ID}`), { timeout: 20_000 })
      await expectAssistantReplyVisible(page, `cloud ack 1: ${first}`)
      await expectOnlyHarnessModelControl(page, harnessCase.modelLabel)

      // Harness Select is locked now that the cloud session exists.
      await expect(page.getByRole("button", { name: harnessCase.option }).last()).toBeDisabled()

      await page.reload({ waitUntil: "domcontentloaded" })
      await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
      await expectOnlyHarnessModelControl(page, harnessCase.modelLabel)
      await expect(page.getByRole("button", { name: harnessCase.option }).last()).toBeDisabled()

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

  test("Pi reuses the configured OpenCode pair on a cloud workspace without relay options requests — behavior 2", async ({ page }) => {
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

    await page.getByRole("button", { name: /^OpenCode$/ }).last().click()
    await page.getByRole("option", { name: /^Pi$/ }).click()
    await expect(page.getByRole("button", { name: /^Pi$/ }).last()).toBeVisible({ timeout: 20_000 })
    await expectOnlyHarnessModelControl(page, /Big Pickle|big-pickle/i)
    await expect(page.locator('[title="Agent runtime unreachable after timeout"]')).toHaveCount(0)
    await expect(page.locator('[title="Connecting to agent runtime..."]')).toHaveCount(0)

    const first = "core harness cloud pi first turn"
    await input.click()
    await input.fill(first)
    await expect(input).toContainText(first, { timeout: 10_000 })
    await expect(page.locator(SELECTORS.submitControl).last()).toBeEnabled({ timeout: 5_000 })
    await page.locator(SELECTORS.submitControl).last().click()

    await expect.poll(() => mock.requests.cloudPromptCount, { timeout: 15_000 }).toBe(1)
    expect(mock.requests.cloudPromptBodies[0]).toMatchObject({ text: first, providerID: "opencode", modelID: "big-pickle" })
    await expectAssistantReplyVisible(page, `cloud ack 1: ${first}`)

    // Zero relay config-options requests for the entire scenario — pi has no config options.
    expect(mock.requests.cloudHarnessOptionsCount).toBe(0)
  })

  test("relay harness-config-options requests are scoped per harness — switching resolves each harness's own model, never a stale one — behavior 3", async ({ page }) => {
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

    await switchDraftHarness(page, /^Claude$/, 0)
    await expectOnlyHarnessModelControl(page, /Sonnet 4\.6|claude-sonnet-4-6/i)
    await expect.poll(() => mock.requests.cloudHarnessOptionsHarnesses.includes("claude-acp"), { timeout: 10_000 }).toBe(true)

    await page.getByRole("button", { name: /^Claude$/ }).last().click()
    await page.getByRole("option", { name: /^Codex$/ }).nth(1).click()
    await expectOnlyHarnessModelControl(page, /GPT-5\.5|gpt-5\.5/i)
    await expect.poll(() => mock.requests.cloudHarnessOptionsHarnesses.includes("codex-app-server"), { timeout: 10_000 }).toBe(true)

    // Every request the mock recorded named the harness it was actually resolving for
    // (a real cross-harness leak would show a request for "codex-app-server" answered
    // with claude's model, which expectOnlyHarnessModelControl above already ruled out
    // for the currently-rendered control) — this asserts the REQUEST side of that
    // scoping: no request for one harness's options ever went out unlabeled/blank.
    expect(mock.requests.cloudHarnessOptionsHarnesses.every((h) => h.length > 0)).toBe(true)

    // Zero POSTs to the local readiness endpoint for either switch — cloud drafts never
    // touch it (behavior 4, asserted properly in the next test; sanity-checked here too).
    expect(mock.requests.harnessPostCount).toBe(0)
  })

  test("selecting a configurable harness on a cloud draft sends zero POSTs to the local harness-status endpoint — behavior 4", async ({ page }) => {
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

    // Each switch's trigger label is whatever the PREVIOUS switch just landed on — the
    // trigger's accessible name tracks the currently-selected harness (see
    // switchDraftHarness's fromLabel param), so this loop must thread it through instead
    // of re-opening a selector still labeled "OpenCode" after the first switch.
    let currentLabel: RegExp = /^OpenCode$/
    for (const [option, index] of [[/^Claude$/, 0], [/^Codex$/, 1], [/^Cursor$/, 0]] as const) {
      await switchDraftHarness(page, option, index, currentLabel)
      await expect(page.getByRole("button", { name: option }).last()).toBeVisible({ timeout: 20_000 })
      currentLabel = option
    }
    await expect.poll(() => mock.requests.cloudHarnessOptionsCount, { timeout: 10_000 }).toBeGreaterThan(0)

    // The local readiness POST is the endpoint spec 3's local matrix relies on for
    // draft-time readiness — deterministic proof it was never called for this cloud
    // draft, across three separate harness switches.
    expect(mock.requests.harnessPostCount).toBe(0)
  })

  test("a non-OpenCode harness picked on a local draft resets to OpenCode after a same-pane navigation into a cloud workspace, before any cloud request — behavior 5", async ({ page }) => {
    const mock = await installMockRuntime(page, {
      dir: DIR,
      projectId: PROJECT_ID,
      projectName: PROJECT_NAME,
      cloud: { workspaceId: WORKSPACE_ID, relayOrigin: RELAY_ORIGIN, projectName: WORKSPACE_PROJECT_NAME },
    })
    await seedProjects(page)

    await page.goto(`/${slug(DIR)}/session`)
    await page.waitForLoadState("domcontentloaded")
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    const localInput = page.getByRole("textbox", { name: /Ask anything/i }).last()
    await expect(localInput).toBeVisible({ timeout: 20_000 })

    // Pick a non-OpenCode harness on the LOCAL draft.
    await switchDraftHarness(page, /^Claude$/, 0)
    await expectOnlyHarnessModelControl(page, /Sonnet 4\.6|claude-sonnet-4-6/i)

    // Client-side navigate the SAME pane to the cloud workspace's own top-level project
    // entry via the empty-draft header's project picker (no page reload — this is the
    // exact same-pane carryover vector shouldResetWorkspaceDraftHarness guards against).
    const projectPicker = page.getByRole("button", { name: PROJECT_NAME }).last()
    await expect(projectPicker).toBeVisible({ timeout: 20_000 })
    await projectPicker.click()
    await page.getByRole("option", { name: WORKSPACE_PROJECT_NAME }).click()

    await expect(page).toHaveURL(new RegExp(`/w/${WORKSPACE_ID}/session$`), { timeout: 20_000 })
    // The draft harness reset to OpenCode BEFORE any cloud request — proven by the DOM
    // (exactly one plain model control) and by zero relay options requests having ever
    // fired for the leaked "claude-acp" selection.
    await expectOnlyOpenCodeModelControl(page)
    expect(mock.requests.cloudHarnessOptionsHarnesses.includes("claude-acp")).toBe(false)

    const cloudInput = page.getByRole("textbox", { name: /Ask anything/i }).last()
    await expect(cloudInput).toBeVisible({ timeout: 20_000 })
    // `expectOnlyOpenCodeModelControl` above only proves a plain (non-harness)
    // model control is showing, not that it has RESOLVED a real model yet — the
    // cloud workspace's own provider/model catalog is a fresh relay request fired
    // on this first-ever visit to it, and sending before it resolves hits the
    // composer's own "no-model" submit block (see core-cloud-provisioning.spec.ts
    // and core-user-hosted-workspace.spec.ts for the same race).
    await expect(page.locator('[data-action="prompt-model"]:visible')).toContainText(/Big Pickle|big-pickle/i, { timeout: 20_000 })
    const text = "core harness cloud no-leak turn"
    await cloudInput.click()
    await cloudInput.fill(text)
    await expect(cloudInput).toContainText(text, { timeout: 10_000 })
    await page.locator(SELECTORS.submitControl).last().click()

    await expect.poll(() => mock.requests.cloudPromptCount, { timeout: 15_000 }).toBe(1)
    // The strongest proof: the payload actually dispatched through the relay carries
    // "opencode", never the local pane's "claude-acp" selection.
    expect(mock.requests.cloudPromptBodies[0]).toMatchObject({ text, providerID: "opencode", modelID: "big-pickle" })
    await expectAssistantReplyVisible(page, `cloud ack 1: ${text}`)
  })
})
