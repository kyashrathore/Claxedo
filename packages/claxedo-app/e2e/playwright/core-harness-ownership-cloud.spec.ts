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
 * route, and a draft pane navigated from a local directory (with a non-OpenCode harness
 * picked) into a workspace-runtime directory shows the WORKSPACE's own default rather than
 * the local selection — because the draft default is stored per-directory, not because
 * anything is force-reset (that reset hook is gone; see STATE MODEL). So a cloud/user-hosted
 * session can never silently inherit a harness/model chosen for a different (local or
 * other-workspace) scope, and the local scope's own choice is not destroyed either.
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
 *   - Model options for a configurable harness (`claude-sdk`,
 *     `codex-app-server`, `cursor-sdk`) come from a DIFFERENT endpoint once
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
 *   - Cross-workspace isolation is PER-DIRECTORY PERSISTENCE, not a reset hook. The old
 *     `shouldResetWorkspaceDraftHarness` guard was deleted (owner decision 27) and does
 *     not exist in `src/` any more — do not re-cite it. What isolates the two drafts now
 *     is the draft-default record's STORAGE SCOPE: `createDraftDefaultPreferences`
 *     (`src/features/session/harness/draft-defaults.ts`) keys every record by
 *     `Persist.serverWorkspace(serverUrl, workspaceKey, "session.draft-default.v1")`, i.e.
 *     `opencode.server.<server>.<sum>.workspace.<dirHead>.<dirSum>.dat:workspace:session.draft-default.v1`
 *     (`src/platform/persistence/persist.ts:223-233,382-384`) — a DIFFERENT localStorage
 *     key per (server, workspaceKey) pair. `rememberDraftHarness`
 *     (`src/features/session/harness/harness-store.ts:171-199`) writes that record when the
 *     user picks a draft harness; `beginDraftDefault` (`harness-store.ts:189-224`) re-reads
 *     it and re-seeds the scope's harness whenever the scope's `workspaceKey` changes.
 *     The scope key is `panePreferenceScope` — when a stable `draftId` (the pane's
 *     `surfaceId`) is supplied the scope is `draft:${draftId}` and does NOT change with
 *     `directory`, so a SAME-PANE, same-tab, client-side navigation (Solid Router's
 *     `navigate()`, via the empty-draft header's project chip, `openProject` in
 *     `src/features/session/ui/components/session-new-design-view.tsx:199-208`) from a
 *     local directory into a workspace-runtime directory keeps the scope but swaps the
 *     workspaceKey — so the cloud draft re-seeds from the CLOUD directory's own (absent)
 *     record and lands on `"opencode"`, while the local directory's `"claude-sdk"` record
 *     is untouched and restores on the way back. That round trip is what behavior 5
 *     asserts, key-for-key.
 *
 * ANATOMY — the unified `[data-action="prompt-harness-model"]` picker and submit control,
 *   plus:
 *   - relay lane path prefix `/workspaces/<workspaceId>/...` — every session/prompt/
 *     message/config/capabilities/provider/harness-options request for a relay-backed
 *     session lands here, never on the bare `/session/...`/`/api/claxedo/...` paths.
 *   - `/workspaces/<workspaceId>/api/wr/harness-config-options?harness=<type>` — the
 *     relay's per-harness model-options endpoint (query-param scoped, see STATE MODEL).
 *   - the empty-draft header's project picker (only rendered pre-send,
 *     `session-new-design-view.tsx`, `!runtimeMode()`) — the vehicle this spec uses to
 *     reproduce the same-pane local↔cloud navigation, since selecting an entry calls
 *     `navigate()` (client-side, no page reload). It is MID-MIGRATION between an
 *     `@opencode-ai/ui` `Select` (trigger's accessible name IS the project label, entries
 *     are real `role="option"`s) and `SessionContextRow`'s chip popover (trigger carries a
 *     STATIC `aria-label="Project"`, rows are `List` buttons with NO ARIA listbox roles),
 *     so `getByRole("button", {name: <projectName>})` / `getByRole("option", ...)` is NOT
 *     a safe address for it. `openProjectFromChip` below drives whichever shape is mounted
 *     and asserts the project label on the row either way — see its comment.
 *
 * BEHAVIORS —
 *   1. For each picker-selectable configurable harness (`claude-sdk`,
 *      `codex-app-server`, `cursor-sdk`): selecting it on a cloud
 *      workspace's draft resolves its model via the relay's
 *      `/api/wr/harness-config-options` endpoint (never the local
 *      `/api/claxedo/agent-config/harness/options` endpoint), and that harness owns the
 *      submit payload's `providerID`/`modelID`/`agent` through draft → first send
 *      (session create, relay lane) → reload → a second send — all dispatched through
 *      `/workspaces/:workspaceId/...`, never the bare `/session/...` paths. The harness
 *      picker's Harness section is disabled once the session exists, identically to local.
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
 *      project, then client-side-navigating (via the project chip picker, no page reload)
 *      that SAME pane to a cloud workspace's directory, leaves the cloud draft on its OWN
 *      OpenCode default BEFORE any cloud request is made: exactly one unified picker
 *      with `data-harness="opencode"` is present immediately after the navigation
 *      settles, and the prompt subsequently sent through the cloud workspace carries
 *      `providerID: "opencode"` — the local harness/model selection never reaches the
 *      relay lane. The local choice is not discarded either: it stays in ITS OWN
 *      directory-scoped draft-default localStorage key (a different key from any the
 *      cloud directory writes), and navigating the same pane BACK restores Claude plus
 *      its harness model control.
 *
 * INVARIANTS — harness ownership (#1 in e2e/INVARIANTS.md): the selected harness owns
 *   model/effort/payload at every stage, exactly one unified picker exists at a time, a
 *   harness is locked once the session is created. No silent fallback (#3): the OpenCode
 *   selection behavior 5 observes on the cloud draft is NOT a fallback at all — it is the
 *   cloud directory's OWN unset draft-default resolving to the default harness, proven by
 *   the local directory's record surviving the trip untouched. Submit gating (#4): every wait below is a
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
 * The shared runtime models the cloud session lane, so every behavior below executes.
 */
import { expect, test, type Page } from "@playwright/test"
import { ensureComposerModelSelected, expectAssistantReplyVisible, expectTurnCounts, SELECTORS } from "../helpers/turn-oracle"
import { installMockRuntime, type Harness } from "../helpers/mock-runtime"
import { decodeDraftDefaultRecord } from "../../src/features/session/harness/draft-defaults"

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

async function switchDraftHarness(page: Page, optionName: RegExp, optionIndex: number) {
  await page.locator('[data-action="prompt-harness-model"]:visible').last().click()
  const picker = page.locator('[data-component="harness-model-picker"]')
  await picker.locator('[data-slot="harness-picker-section"]').first().click()
  await picker.getByRole("button", { name: optionName }).nth(optionIndex).click()
  await page.keyboard.press("Escape")
}

// The canonical SessionContextRow project chip. Rows are `@opencode-ai/ui` List
// buttons keyed by directory; the readable project name remains an asserted fact.
async function openProjectFromChip(page: Page, directory: string, projectName: string) {
  const chip = page.locator('[data-slot="context-chip-project"]').filter({ visible: true })
  await expect(chip).toHaveCount(1, { timeout: 20_000 })
  await chip.click()
  const row = page.locator(`[data-slot="list-item"][data-key="${directory}"]`).filter({ visible: true })
  await expect(row).toHaveCount(1, { timeout: 20_000 })
  await expect(row).toContainText(projectName)
  await row.click()
}

// Every draft-default record currently in localStorage, key -> raw JSON. The key is
// `Persist.serverWorkspace(serverUrl, workspaceKey, "session.draft-default.v1")`, so a
// DISTINCT key per (server, workspace directory) pair — which is exactly the per-directory
// scoping behavior 5 has to prove, hence key-level (not `some()`-over-all-values) checks.
function readDraftDefaults(page: Page) {
  return page.evaluate(() =>
    Object.fromEntries(
      Object.entries(localStorage)
        .filter(([key]) => key.includes("draft-default"))
        .map(([key, value]) => [key, String(value)] as const),
    ),
  )
}

/**
 * The harness a stored draft-default record opens a new draft with, decoded by
 * the app's OWN reader (`decodeDraftDefaultRecord`).
 *
 * Not a substring match on the raw JSON: the record is
 * `{version, byHarness, lastHarness}`, and a raw-string match would assert the
 * shape rather than the fact this test means to prove.
 */
function draftDefaultHarness(raw: string | undefined) {
  return raw === undefined ? undefined : decodeDraftDefaultRecord(raw)?.record.lastHarness
}

function visibleHarnessTrigger(page: Page, harness: Harness) {
  return page.locator(`[data-action="prompt-harness-model"][data-harness="${harness}"]:visible`)
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
  await expect(visibleHarnessTrigger(page, "opencode")).toHaveCount(1, { timeout: 20_000 })
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
  // The picker's built-in options are the native harnesses only — first-party
  // ACP rows left it when operator-configured ACP connections became the ACP
  // group (agent-harness-selector BUILTIN_HARNESS_OPTIONS). ACP harnesses stay
  // valid SESSION identities (seeded/historical flows elsewhere in this file
  // and in the rendering matrix), but a cloud DRAFT can no longer pick one, so
  // this draft-path matrix covers exactly what the picker offers.
  for (const harnessCase of [
    { harness: "claude-sdk" as Harness, option: /^Claude$/, optionIndex: 0, modelLabel: /Sonnet 4\.6|claude-sonnet-4-6/i, providerID: "claude-sdk", modelID: "claude-sonnet-4-6" },
    { harness: "codex-app-server" as Harness, option: /^Codex$/, optionIndex: 0, modelLabel: /GPT-5\.5|gpt-5\.5/i, providerID: "codex-app-server", modelID: "gpt-5.5" },
    { harness: "cursor-sdk" as Harness, option: /^Cursor$/, optionIndex: 0, modelLabel: /Cursor Auto|cursor-auto/i, providerID: "cursor-sdk", modelID: "cursor-auto" },
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
      await expect(page).toHaveURL(sessionUrlPattern(`ses_cloud_${WORKSPACE_ID}`), { timeout: 20_000 })
      await expectAssistantReplyVisible(page, `cloud ack 1: ${first}`)
      await expectOnlyHarnessModelControl(page, harnessCase.modelLabel)

      // Harness Select is locked now that the cloud session exists.
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

    await switchDraftHarness(page, /^Pi$/, 0)
    await expect(visibleHarnessTrigger(page, "pi")).toHaveCount(1, { timeout: 20_000 })
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
    expect(mock.requests.cloudPromptBodies[0]).toMatchObject({ text: first, providerID: "opencode", modelID: "big-pickle-1" })
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
    await expect.poll(() => mock.requests.cloudHarnessOptionsHarnesses.includes("claude-sdk"), { timeout: 10_000 }).toBe(true)

    await switchDraftHarness(page, /^Codex$/, 0)
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

    for (const [option, index] of [[/^Claude$/, 0], [/^Codex$/, 0], [/^Cursor$/, 0]] as const) {
      await switchDraftHarness(page, option, index)
    }
    await expect.poll(() => mock.requests.cloudHarnessOptionsCount, { timeout: 10_000 }).toBeGreaterThan(0)

    // The local readiness POST is the endpoint spec 3's local matrix relies on for
    // draft-time readiness — deterministic proof it was never called for this cloud
    // draft, across three separate harness switches.
    expect(mock.requests.harnessPostCount).toBe(0)
  })

  // Owner decision 27 (harness reset removed): `shouldResetWorkspaceDraftHarness` was
  // deleted. Investigation showed it was INERT for this same-pane local→cloud navigation:
  // the cloud workspace draft is a distinct per-directory scope that defaults to OpenCode
  // on its own, and the user's local Claude choice is preserved per-directory (its
  // draft-default survives the navigation, verified below) — so removing the reset does
  // NOT change this outcome and does NOT contradict the "keep the user's choice" contract:
  // the cloud pane shows the WORKSPACE's own default, while nothing clobbers the local
  // selection. A prompt sent through the cloud workspace therefore still carries OpenCode.
  test("a cloud workspace draft keeps its own OpenCode default while the local draft's Claude choice is preserved per-directory — behavior 5", async ({ page }) => {
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

    // Pick a non-OpenCode harness on the LOCAL draft.
    await switchDraftHarness(page, /^Claude$/, 0)
    await expectOnlyHarnessModelControl(page, /Sonnet 4\.6|claude-sonnet-4-6/i)

    // Snapshot the draft-default records while the LOCAL directory is the only one ever
    // visited: every key present now is, by construction, the local directory's own. That
    // is what makes the post-navigation checks below key-scoped rather than a blind
    // "somewhere in localStorage" match — the storage key embeds a hash of the workspace
    // directory, so it cannot be reconstructed in the test, but it CAN be pinned by
    // observing it before the second directory exists.
    await expect
      .poll(async () => Object.values(await readDraftDefaults(page)).filter((value) => draftDefaultHarness(value) === "claude-sdk").length, {
        timeout: 20_000,
      })
      .toBe(1)
    const localDraftDefaults = await readDraftDefaults(page)
    const localKeys = Object.keys(localDraftDefaults)
    expect(localKeys).toHaveLength(1)
    const localDraftDefaultKey = localKeys[0]!

    // Client-side navigate the SAME pane to the cloud workspace's own top-level project
    // entry via the empty-draft header's project picker (no page reload).
    await openProjectFromChip(page, WORKSPACE_ID, WORKSPACE_PROJECT_NAME)

    await expect(page).toHaveURL(new RegExp(`/w/${WORKSPACE_ID}/session$`), { timeout: 20_000 })
    // The cloud workspace draft shows its OWN OpenCode default — exactly one plain model
    // control, no relay options ever fetched for a carried-over "claude-sdk".
    await expectOnlyOpenCodeModelControl(page)
    await expect(visibleHarnessTrigger(page, "opencode")).toHaveCount(1, { timeout: 20_000 })
    expect(mock.requests.cloudHarnessOptionsHarnesses.includes("claude-sdk")).toBe(false)

    // ...and the user's local Claude choice is NOT lost — it stays under the LOCAL
    // directory's own storage key, byte-identical to what was written before the
    // navigation, while NO other draft-default key (i.e. nothing the cloud directory
    // writes) ever carries "claude-sdk". That pair of checks is the per-directory scoping
    // claim: a change to the key SHAPE that merged both directories into one record would
    // fail the second half instead of silently passing a substring search.
    const afterNavigation = await readDraftDefaults(page)
    expect(afterNavigation[localDraftDefaultKey]).toBe(localDraftDefaults[localDraftDefaultKey])
    expect(draftDefaultHarness(afterNavigation[localDraftDefaultKey])).toBe("claude-sdk")
    expect(
      Object.entries(afterNavigation)
        .filter(([key]) => key !== localDraftDefaultKey)
        .filter(([, value]) => draftDefaultHarness(value) === "claude-sdk"),
    ).toEqual([])

    // "Preserved per-directory" means RESTORED, not merely retained — so navigate the same
    // pane back to the local project and prove the local draft comes back on Claude with
    // its harness-owned model control, then return to the cloud draft (which must still be
    // on its own OpenCode default) before sending.
    await page.evaluate(() => {
      const writes = (window as Window & { __claxedoHistoryWrites?: string[] }).__claxedoHistoryWrites
      if (writes) writes.length = 0
    })
    await openProjectFromChip(page, DIR, PROJECT_NAME)
    // Project-chip navigation resolves the local directory through project inventory
    // before the first history write. The physical path never appears and then swaps;
    // `/w/` is keyed by the opaque project/workspace ID from the start.
    await expect(page).toHaveURL(new RegExp(`/w/${PROJECT_ID}/session$`), { timeout: 20_000 })
    const historyWrites = await page.evaluate(
      () => (window as Window & { __claxedoHistoryWrites?: string[] }).__claxedoHistoryWrites ?? [],
    )
    expect(historyWrites).toEqual([`/w/${PROJECT_ID}/session`])
    expect(historyWrites.join("\n")).not.toContain(encodeURIComponent(DIR))
    await expect(visibleHarnessTrigger(page, "claude-sdk")).toHaveCount(1, { timeout: 20_000 })
    await expectOnlyHarnessModelControl(page, /Sonnet 4\.6|claude-sonnet-4-6/i)

    await openProjectFromChip(page, WORKSPACE_ID, WORKSPACE_PROJECT_NAME)
    await expect(page).toHaveURL(new RegExp(`/w/${WORKSPACE_ID}/session$`), { timeout: 20_000 })
    await expectOnlyOpenCodeModelControl(page)
    await expect(visibleHarnessTrigger(page, "opencode")).toHaveCount(1, { timeout: 20_000 })

    // `filter({visible: true})`, not `.last()`: the round trip above leaves the prior
    // directories' composers mounted-but-hidden, and DOM order does not guarantee the live
    // one is last.
    const cloudInput = page.getByRole("textbox", { name: /Ask anything/i }).filter({ visible: true })
    await expect(cloudInput).toHaveCount(1, { timeout: 20_000 })
    // Cloud draft keeps OpenCode as harness (asserted above) but does not invent a
    // catalog model default — pick Big Pickle the same way a user would before send.
    const text = "core harness cloud own-default turn"
    await cloudInput.click()
    await cloudInput.fill(text)
    await expect(cloudInput).toContainText(text, { timeout: 10_000 })
    await ensureComposerModelSelected(page, { modelName: /^Big Pickle$/i, search: "Big Pickle" })
    await page.locator(`${SELECTORS.submitControl}:visible`).last().click()

    await expect.poll(() => mock.requests.cloudPromptCount, { timeout: 15_000 }).toBe(1)
    // The cloud workspace draft dispatches its own OpenCode default, never the local pane's
    // "claude-sdk" selection (which is preserved for the local directory, not carried here).
    expect(mock.requests.cloudPromptBodies[0]).toMatchObject({ text, providerID: "opencode", modelID: "big-pickle-1" })
    await expectAssistantReplyVisible(page, `cloud ack 1: ${text}`)
  })
})
