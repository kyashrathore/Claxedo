/**
 * Renderer-only replay of canonical presentation fixtures.
 *
 * These tests inject already-projected message parts, not raw provider traffic.
 * They verify timeline renderers, lifecycle updates, and dock presentation, but
 * do not prove adapter translation, authentication, or external connectivity.
 * Fixture names describe provenance, not current provider capabilities: question
 * and live subagent fixtures exercise generic rendering even when the external
 * OpenCode adapter does not advertise those features. Protocol coverage belongs
 * to the adapter tests in packages/opencode-server-adapter.
 */
import { expect, test, type Page } from "@playwright/test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  installMockRuntime,
  type MockRuntimeChildSession,
  type MockRuntimeHandles,
  type MockRuntimeSubagentRow,
} from "../helpers/mock-runtime"
import { ensureComposerModelSelected, expectAssistantReplyVisible, selectComposerAgent, SELECTORS } from "../helpers/turn-oracle"

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "harness-traces")

type Envelope = { directory: string; payload: unknown }

/**
 * ACP-family fixtures (claude-acp/codex-acp/cursor-acp — verified via
 * `python3 -c "..." | sort -u` over every `messageID` field in each committed
 * `e2e/fixtures/harness-traces/<harness>.json`) carry a MIX of two message
 * IDs: `msg_assistant_1` (correctly stamped on `message.completed`/
 * `todo.updated`-type envelopes) and the ACP adapter's OWN internally
 * generated id, literally `"message-1"` (on every real `message.part.*`
 * envelope — the translation this spec exists to replay verbatim, so this is
 * NOT something to "fix" at the generator/translation layer). Native-SDK
 * fixtures (claude-sdk/codex-app-server/cursor-sdk) and the hand-authored
 * opencode/pi fixtures use `msg_assistant_1` uniformly and are unaffected.
 * Since the client attaches parts to the assistant row by exact `messageID`
 * match against the row `installMockRuntime`'s `driveTurn` already created
 * during priming (the FIXTURE FILES use `msg_assistant_1` uniformly —
 * `generate-harness-fixtures.ts`'s `identity()` documents that convention —
 * while driveTurn's live row id follows the production `${userMessageID}_r`
 * convention, exposed as `mock.requests.promptBodies[n].assistantID`), a part
 * carrying any OTHER `messageID` orphans it — it is parsed and accepted by
 * the client (confirmed via network trace: 200, correct JSON) but never
 * attaches to any rendered row, so the whole trace is silently invisible.
 * Remapped HERE, in-memory, at load time — never hand-editing the committed
 * fixture JSON (DoD #4's "a script regenerates them; hand-edited fixtures are
 * rejected" governs the FILES, not this in-memory replay adaptation).
 */
function remapMessageIds<T>(value: T, canonicalId: string): T {
  if (Array.isArray(value)) return value.map((item) => remapMessageIds(item, canonicalId)) as never
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = k === "messageID" && typeof v === "string" && v !== canonicalId ? canonicalId : remapMessageIds(v, canonicalId)
    }
    return out as never
  }
  return value
}

function loadTrace(harness: string, assistantId: string): Envelope[] {
  const raw = JSON.parse(readFileSync(join(FIXTURES_DIR, `${harness}.json`), "utf-8"))
  const envelopes: Envelope[] = Array.isArray(raw) ? raw : (raw.envelopes ?? raw.main ?? [])
  return remapMessageIds(envelopes, assistantId)
}

function loadFixtureFile(harness: string, assistantId: string): Record<string, unknown> {
  return remapMessageIds(JSON.parse(readFileSync(join(FIXTURES_DIR, `${harness}.json`), "utf-8")), assistantId)
}

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

const PROJECT_ID = "proj_harness_rendering_matrix"

async function seedOneProject(page: Page, dir: string) {
  await page.addInitScript(({ dir, projectId }: { dir: string; projectId: string }) => {
    localStorage.clear()
    ;(window as typeof window & { __CLAXEDO__?: { serverUrl?: string; activeDirectory?: string } }).__CLAXEDO__ = {
      serverUrl: window.location.origin,
      activeDirectory: dir,
    }
    localStorage.setItem(
      "claxedo.global.dat:server",
      JSON.stringify({
        list: [],
        projects: { local: [{ id: projectId, worktree: dir, expanded: true }] },
        lastProject: {},
        workspaceServer: {},
        closedProjects: {},
      }),
    )
  }, { dir, projectId: PROJECT_ID })
}

function sessionUrlPattern(sessionId: string) {
  return new RegExp(`(?:/s/${sessionId}|/w/[^/]+/session/${sessionId})$`)
}

/**
 * Filters `mock.requests.console` down to genuine page-level errors, matching the
 * convention already established by `core-boot-deep-links-home.spec.ts`'s
 * `nonProviderConsole`. This app runs an always-on, session-independent central-relay
 * connection (`src/context/global-sdk.tsx`'s "central" stream, `src/providers/
 * claxedo-events`) that defaults to `http://127.0.0.1:3001` (`src/index.tsx:96`) when
 * no real backend is present — `installMockRuntime`/`seedOneProject` mock only the
 * session-scoped routes on the page's own origin, not this independent background
 * probe, so it legitimately logs "Failed to load resource"/connection-refused noise
 * in every Tier M spec that doesn't run a real backend. That noise is not this
 * spec's concern (behavior 8 only cares whether `session.diff` adds a phantom
 * timeline row); a real rendering exception still surfaces as an uncaught
 * `pageerror:` entry, which this filter does NOT swallow.
 */
function nonBackgroundNoiseConsole(entries: string[]) {
  return entries.filter(
    (item) =>
      !item.includes("Failed to load resource") &&
      !item.includes("ERR_CONNECTION_REFUSED") &&
      !item.includes("[global-sdk]") &&
      !item.includes("[claxedo-events]"),
  )
}

/**
 * Establishes ONE oracle-proven turn (per `e2e/INVARIANTS.md`'s #1 rule) for a given
 * harness, then returns the mock handle so the test can layer the harness's real
 * translated trace ONTO that already-settled assistant message. The returned
 * `assistantId` is driveTurn's live row id for the primed turn
 * (`${userMessageID}_r`, production convention) — pass it to
 * `loadTrace`/`loadFixtureFile` so fixture parts attach to that row.
 */
/**
 * Trace-fixture family -> the harness identity the app and the runtime speak.
 *
 * Two DIFFERENT vocabularies meet in this spec and must not be conflated:
 *   - the fixture family name (`claude-acp`), which names a recorded trace under
 *     `e2e/fixtures/harness-traces/` and is baked into that trace's `directory`
 *     and `sessionID` strings — regenerating is the only way to change it, and
 *     the committed traces are the frozen evidence these tests replay;
 *   - the harness IDENTITY the mock runtime is installed with, which must be a
 *     string `normalizeHarnessIdentity` (agent-sdk-runtime/src/harness-types.ts)
 *     accepts, because the real server runs that same validator. Open ACP
 *     connections are `acp:<slug>`.
 *
 * Only the identity moves here. Fixture names, directories, and session ids are
 * unchanged, so every replayed trace and every assertion is the same one.
 */
const HARNESS_IDENTITY_BY_FIXTURE: Record<string, string> = {
  "claude-acp": "acp:claude",
  "codex-acp": "acp:codex",
  "cursor-acp": "acp:cursor",
}

function harnessIdentityFor(fixture: string): string {
  return HARNESS_IDENTITY_BY_FIXTURE[fixture] ?? fixture
}

async function primeHarness(
  page: Page,
  harness: string,
  subagents?: {
    rows: MockRuntimeSubagentRow[]
    children?: MockRuntimeChildSession[]
    runtimeEventAuthorizeParent?: (parentSessionId: string) => boolean
  },
): Promise<{
  mock: MockRuntimeHandles
  dir: string
  sessionId: string
  assistantId: string
  assistantInfo: Record<string, unknown>
}> {
  const dir = `/tmp/e2e-core-harness-rendering-matrix-${harness}`
  const sessionId = `ses_harness_matrix_${harness}`
  const mock = await installMockRuntime(page, {
    dir,
    sessionId,
    projectId: PROJECT_ID,
    workspaceId: PROJECT_ID,
    harness: harnessIdentityFor(harness) as never,
    ...(subagents ? {
      subagents: { [`ses_harness_matrix_${harness}`]: subagents.rows },
      childSessions: subagents.children,
      runtimeEventAuthorizeParent: subagents.runtimeEventAuthorizeParent,
    } : {}),
    // Pin opencode to GPT-5 in the mock catalog. Drafts no longer invent a default
    // model — primeHarness must pick explicitly before the first send (same convention
    // as core-first-prompt-local and turn-oracle's ensureComposerModelSelected).
    ...(harness === "opencode" ? { harnessModels: { opencode: [{ id: "gpt-5", name: "GPT-5" }] } } : {}),
  })
  await seedOneProject(page, dir)

  await page.goto(`/${slug(dir)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

  // A fresh draft has no implicit agent. Select the configured connection or native
  // SDK explicitly so this matrix exercises the same structured target contract as
  // production instead of relying on the removed OpenCode fallback.
  const agentName = harness === "claude-sdk"
    ? "Claude"
    : harness === "codex-app-server"
      ? "Codex"
      : harness === "cursor-sdk"
        ? "Cursor"
        : harness === "pi"
          ? "Pi"
          : harness === "opencode"
            ? "OpenCode"
            : harness
  await selectComposerAgent(page, agentName)

  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await expect(input).toBeVisible({ timeout: 20_000 })
  const promptText = `matrix probe ${harness}`
  await input.click()
  await input.fill(promptText)
  await ensureComposerModelSelected(page)
  await page.locator(SELECTORS.submitControl).last().click()

  await expect(page).toHaveURL(sessionUrlPattern(sessionId), { timeout: 20_000 })
  await expectAssistantReplyVisible(page, `ack 1: ${promptText}`)

  const assistantId = mock.requests.promptBodies[0]?.assistantID
  if (!assistantId) throw new Error("primeHarness: no prompt dispatch recorded — cannot derive the assistant row id")

  // Wait for the primed turn to SETTLE (driveTurn stamps `time.completed` a tick
  // after the reply's final part — reply visibility above races it), capture the
  // settled assistant info row, then RE-OPEN it. Since the settled-message part
  // guard (opencode-conversation.ts's `settledAssistantMessage`, 69c6977757) a
  // completed assistant message rejects part events for part ids it does not
  // already have — so every test here (whether it drives parts through
  // `replay()` or emits them directly) needs the row deterministically open
  // before it delivers fixture parts. Waiting first makes the re-open
  // deterministic (no race against driveTurn's async settle); re-opening here,
  // once, covers direct-emit tests that never call `replay()`.
  let assistantInfo: Record<string, unknown> | undefined
  await expect.poll(async () => {
    const rows = await page.evaluate(async (id) => {
      const response = await fetch(`/session/${id}/message`)
      const page = await response.json() as {
        messages: Array<{ info?: { id?: string; time?: { completed?: number } } }>
      }
      return page.messages
    }, sessionId)
    const row = rows.find((item) => item.info?.id === assistantId)
    if (typeof row?.info?.time?.completed !== "number") return false
    assistantInfo = row.info as Record<string, unknown>
    return true
  }, { timeout: 15_000 }).toBe(true)

  const { completed: _completed, ...openTime } = (assistantInfo!.time ?? {}) as Record<string, unknown>
  mock.emit(
    {
      type: "message.updated",
      properties: { sessionID: assistantInfo!.sessionID, info: { ...assistantInfo!, time: openTime } },
    } as never,
    dir,
  )

  return {
    mock,
    dir,
    sessionId,
    assistantId,
    assistantInfo: assistantInfo!,
  }
}

/**
 * Replays a fixture trace onto the primed assistant row. The row is already
 * SETTLED (`time.completed` — primeHarness waits for it), and settled assistant
 * messages reject part events for unknown part ids (the duplicate-reply race
 * fix in `opencode-conversation.ts`). So the replay brackets the trace with two
 * `message.updated` events: first re-open the row (same info, `time.completed`
 * stripped) so the fixture parts attach, then re-settle it with the original
 * persisted info — deterministic signals only, no wall-clock waits, and the
 * final state (settled turn carrying the fixture parts) matches what these
 * assertions always exercised.
 */
async function replay(
  mock: MockRuntimeHandles,
  dir: string,
  trace: Envelope[],
  assistantInfo: Record<string, unknown>,
) {
  const { completed: _completed, ...openTime } = (assistantInfo.time ?? {}) as Record<string, unknown>
  mock.emit(
    {
      type: "message.updated",
      properties: { sessionID: assistantInfo.sessionID, info: { ...assistantInfo, time: openTime } },
    } as never,
    dir,
  )
  for (const envelope of trace) mock.emit(envelope.payload as never, envelope.directory || dir)
  mock.emit(
    { type: "message.updated", properties: { sessionID: assistantInfo.sessionID, info: assistantInfo } } as never,
    dir,
  )
}

type SubagentHarnessCase = {
  name: string
  harness: string
  providerKind?: string
  providerId?: string
  transcript: MockRuntimeSubagentRow["transcript"]
  mode?: "foreground" | "background"
  openable: boolean
}

const subagentHarnessCases: SubagentHarnessCase[] = [
  { name: "Canonical live transcript fixture", harness: "opencode", providerKind: "opencode", providerId: "ses-child-opencode", transcript: { kind: "live", ref: "ses-child-opencode" }, openable: true },
  { name: "Claude native", harness: "claude-sdk", providerKind: "claude-agent", providerId: "agent-42", transcript: { kind: "messages", ref: "agent-42" }, openable: true },
  { name: "Claude ACP", harness: "claude-acp", transcript: { kind: "messages", ref: "acp:agent-42" }, openable: true },
  { name: "Codex native", harness: "codex-app-server", providerKind: "codex", providerId: "thread-child-1", transcript: { kind: "live", ref: "thread-child-1" }, openable: true },
  { name: "Codex ACP", harness: "codex-acp", providerKind: "codex-acp-thread", providerId: "thread-child-1", transcript: { kind: "none" }, openable: false },
  { name: "Cursor native valid", harness: "cursor-sdk", providerKind: "cursor-agent", providerId: "cursor-agent-1", transcript: { kind: "file", ref: "cursor-transcript-1" }, openable: true },
  { name: "Cursor native invalid", harness: "cursor-sdk", providerKind: "cursor-agent", transcript: { kind: "none" }, openable: false },
  { name: "Cursor ACP", harness: "cursor-acp", transcript: { kind: "none" }, openable: false },
  { name: "Pi foreground", harness: "pi", providerKind: "pi", providerId: "pi-child-foreground", transcript: { kind: "live", ref: "pi-child-foreground" }, mode: "foreground", openable: true },
  { name: "Pi background", harness: "pi", providerKind: "pi", providerId: "pi-child-background", transcript: { kind: "live", ref: "pi-child-background" }, mode: "background", openable: true },
]

function subagentScenario(input: SubagentHarnessCase) {
  const suffix = input.name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")
  const subagentKey = `subagent-${suffix}`
  const toolCallId = `spawn-${suffix}`
  const childSessionId = input.openable ? `ses-child-${suffix}` : undefined
  const description = `Delegate ${input.name}`
  return {
    subagentKey,
    toolCallId,
    childSessionId,
    description,
    fixture: {
      rows: [{
        subagentKey,
        revision: 1,
        mode: input.mode ?? "foreground",
        status: "running",
        label: input.name,
        subagentType: "general-purpose",
        description,
        ...(input.providerKind ? { providerKind: input.providerKind } : {}),
        ...(input.providerId ? { providerId: input.providerId } : {}),
        ...(childSessionId ? { childSessionId } : {}),
        transcript: input.transcript,
        toolCallEdges: [{ toolCallId, role: "spawn", revision: 1 }],
      }] satisfies MockRuntimeSubagentRow[],
      ...(childSessionId ? {
        children: [{
          id: childSessionId,
          parentId: `ses_harness_matrix_${input.harness}`,
          title: input.name,
          prompt: description,
          reply: `child transcript for ${input.name}`,
        }],
      } : {}),
    },
  }
}

function subagentTaskEnvelope(input: {
  sessionId: string
  assistantId: string
  toolCallId: string
  description: string
}): Envelope {
  return {
    directory: "",
    payload: {
      id: `message.part.updated:${input.assistantId}:${input.toolCallId}`,
      type: "message.part.updated",
      properties: {
        sessionID: input.sessionId,
        part: {
          id: input.toolCallId,
          sessionID: input.sessionId,
          messageID: input.assistantId,
          type: "tool",
          callID: input.toolCallId,
          tool: "task",
          state: {
            status: "completed",
            input: { description: input.description, subagent_type: "general-purpose" },
            output: "",
            title: "task",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        },
        time: 2,
      },
    },
  }
}

function completeSubagent(
  mock: MockRuntimeHandles,
  directory: string,
  sessionId: string,
  subagentKey: string,
) {
  // `subagent-updated` is a contract-v4 RuntimeEventEnvelope. The real producers
  // (agent-sdk-runtime's subagent-admission `publish` → RuntimeEventHub) put it on
  // `/api/wr/runtime-events` ONLY, and the app consumes it only there
  // (global-sdk provider's runtime loop → applySubagentRuntimeEventEnvelope).
  // `emitRuntime` is the mock's canonical publisher for that family — `emitFlat`
  // would land the frame on the compat channels the real runtime never carries
  // it on, where nothing applies it.
  mock.emitRuntime({
    directory,
    sessionId,
    payload: {
      type: "subagent-updated",
      subagentKey,
      revision: 2,
      status: "completed",
    },
  })
}

const assistantContent = () => SELECTORS.assistantContentVisible

/**
 * Reasoning summaries are an opt-in feed setting
 * (`settings.general.showReasoningSummaries`, default `false` —
 * `src/platform/settings/provider.tsx`); `renderablePart`
 * (`message-timeline.data.ts`) drops every reasoning part while it is off. Flip it on
 * through the real settings UI — the setting is reactive, so already-streamed reasoning
 * parts appear as soon as the dialog closes.
 */
async function enableReasoningSummaries(page: Page) {
  await page.getByTestId("rail-account-trigger").click()
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click()
  const dialog = page.locator('[data-slot="dialog-container"]').last()
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  const toggle = dialog.locator('[data-action="settings-feed-reasoning-summaries"] [data-slot="switch-control"]')
  await toggle.scrollIntoViewIfNeeded()
  await toggle.click()
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden({ timeout: 5_000 })
}

/**
 * SESSION-TIMELINE REDESIGN (2026-07-18) — three behaviors this file's
 * assertions now account for, verified against
 * the live DOM (`message-timeline.tsx`/`message-timeline.data.ts`):
 *  (a) TURN FOLD — an assistant turn with more than a couple of part groups collapses
 *      its middle groups behind a `[data-component="turn-fold"]` toggle ("Worked for …").
 *      Every tool group beyond the fold threshold is absent from the DOM until the fold
 *      is expanded (this is why a many-tool trace like opencode's renders only its
 *      leading/trailing text until unfolded). `revealTurn()` clicks it open.
 *  (b) WORK GROUPS — consecutive "work" tools (bash/command/shell/local_shell,
 *      edit/edit_file/write/write_file/apply_patch, webfetch, websearch/web_search)
 *      with ≥2 members fold into ONE closed-by-default `[data-component=
 *      "work-group-trigger"]` collapsible (summary e.g. "Edited 1 file · ran 1 command");
 *      a LONE work tool stays a standalone `[data-component="tool-part-wrapper"]` row
 *      whose subtitle is already visible. `revealTurn()` also opens every work- and
 *      context-group trigger so each member's own detail slot is reachable.
 *  (c) SHELL VOCABULARY — the harness-native shell tool names `shell` (Cursor SDK) and
 *      `command` (Codex app-server) are now normalized into the bash renderer
 *      (`shell-submessage-value` = the literal command, title shimmer "Ran"), NOT the
 *      generic MCP fallback they hit before this redesign — so behavior 4 asserts the
 *      command text, not a `basic-tool-tool-title` carrying the raw name.
 */
async function revealTurn(page: Page) {
  // The fold and the tool DOM race the trace replay in BOTH directions: the leading
  // text anchor renders before the turn folds (so a single up-front fold check can run
  // too early and skip a fold that mounts a beat later), and late part updates can
  // re-cross the fold threshold and re-collapse an already-opened fold, unmounting the
  // group triggers mid-expansion. A one-shot click sequence therefore flakes under CI
  // load. Converge instead: keep (re)opening the fold until the tool DOM is visible,
  // and keep (re)opening each group until its Collapsible reports expanded.
  const fold = page.locator('[data-component="turn-fold"] button').first()
  const toolDom = page.locator(
    '[data-component="tool-part-wrapper"], [data-component="work-group-trigger"], [data-component="context-tool-group-trigger"], [data-component="task-tool-card"]',
  ).first()
  const foldOpen = async () => {
    if ((await fold.count().catch(() => 0)) === 0) return
    if ((await fold.getAttribute("aria-expanded", { timeout: 1_000 }).catch(() => null)) === "false") {
      await fold.click({ timeout: 2_000 }).catch(() => {})
    }
  }
  await expect
    .poll(
      async () => {
        await foldOpen()
        if (!(await toolDom.isVisible().catch(() => false))) return false
        // Stability re-check: the fold can MOUNT (closed) a beat after the
        // tools first render — returning on the first visible sample let the
        // fold collapse the tools right after this helper resolved (the exact
        // race the header documents). Hold the condition across a short gap,
        // re-opening a just-mounted fold before the final verdict.
        await page.waitForTimeout(350)
        await foldOpen()
        return toolDom.isVisible().catch(() => false)
      },
      { timeout: 30_000, intervals: [250, 500, 1_000] },
    )
    .toBe(true)
  // Expand every work/context group so each grouped tool's own detail slot is reachable;
  // a lone work tool has no trigger (its subtitle is already visible).
  for (const sel of ['[data-component="work-group-trigger"]', '[data-component="context-tool-group-trigger"]']) {
    const triggers = page.locator(sel)
    for (let i = 0; i < (await triggers.count()); i++) {
      const trigger = triggers.nth(i)
      // `aria-expanded` lives on the Collapsible's BUTTON, which wraps this inner div —
      // read/assert it there, not on the div (the div never has the attribute). Read
      // state BEFORE clicking each round so a just-opened group is never re-clicked
      // closed, and re-open the fold first in case a re-render collapsed it and hid
      // this trigger.
      const expander = trigger.locator("xpath=ancestor-or-self::*[@aria-expanded][1]")
      const expanded = () => trigger.isVisible().catch(() => false).then(async (visible) =>
        visible ? (await expander.getAttribute("aria-expanded", { timeout: 1_000 }).catch(() => null)) === "true" : false,
      )
      await expect
        .poll(
          async () => {
            if (await expanded()) return true
            await foldOpen()
            await trigger.click({ timeout: 2_000 }).catch(() => {})
            await page.waitForTimeout(250)
            return expanded()
          },
          { timeout: 20_000, intervals: [500, 1_000] },
        )
        .toBe(true)
        .catch(async () => {
          await expect(expander, `group trigger ${sel} #${i} never expanded`).toHaveAttribute("aria-expanded", "true")
        })
    }
  }
}

test.describe("core harness rendering matrix @core", () => {
  test("renderer-only canonical fixture — dedicated ToolRegistry renderers for read/list/glob/webfetch/websearch/write/skill — behaviors 1,3", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page, "opencode")
    const trace = loadTrace("opencode", assistantId)
    await replay(mock, dir, trace, assistantInfo)

    const content = page.locator(assistantContent())

    // behavior 1: the injected extra text part renders verbatim (a leading part, shown
    // even while the rest of this many-tool turn is folded — also the delivery anchor
    // that proves the fixture trace reached the store before we unfold).
    await expect(content.getByText("Reading the config, then editing it.")).toBeVisible({ timeout: 45_000 })

    // SESSION-TIMELINE REDESIGN: this turn has enough part groups to fold; unfold it and
    // open every work/context group so each tool's detail slot is reachable (see
    // `revealTurn`).
    await revealTurn(page)

    // behavior 3: read/list/glob — consecutive "context" tools render grouped under ONE
    // closed-by-default `ContextToolGroup` collapsible (`[data-component=
    // "context-tool-group-trigger"]`/`[data-component="context-tool-group-list"]`),
    // opened above.
    await expect(content.locator('[data-component="context-tool-group-list"]').first()).toBeVisible({ timeout: 10_000 })

    // behavior 3: read.
    await expect(content.locator('[data-slot="basic-tool-tool-subtitle"]', { hasText: "config.json" }).first()).toBeVisible({ timeout: 45_000 })
    // list: grouped context-tool items don't carry an individual `data-timeline-part-id`
    // (only the group's `Collapsible` wrapper carries a PLURAL, comma-joined
    // `data-timeline-part-ids`) — assert via that instead, now that the group is
    // expanded above.
    await expect(content.locator('[data-timeline-part-ids*="msg_assistant_1-list"]')).toBeVisible({ timeout: 45_000 })
    // glob (arg shows the literal pattern).
    await expect(content.locator('[data-slot="basic-tool-tool-arg"]', { hasText: "pattern=**/*.json" })).toBeVisible()
    // webfetch (literal url) — webfetch/websearch/write are consecutive "work" tools now
    // folded into ONE work group, opened by `revealTurn`.
    await expect(content.getByRole("link", { name: "https://example.com/docs" })).toBeVisible()
    // websearch (literal query).
    await expect(content.getByText("opencode config schema")).toBeVisible()
    // write (filename).
    await expect(content.locator('[data-slot="message-part-title-filename"]', { hasText: "config.json" })).toBeVisible()
    // skill (title = literal input.name, untranslated — rendered via
    // `[data-slot="basic-tool-tool-title"] class="capitalize agent-title"`, so the
    // rendered text is "Pdf" even though the underlying string is the verbatim lowercase
    // "pdf" — match case-insensitively, scoped to the tool title slot).
    await expect(content.locator('[data-slot="basic-tool-tool-title"]').filter({ hasText: /pdf/i })).toBeVisible()
  })

  test("renderer-only canonical fixture — apply_patch dedicated renderer, GenericTool fallback, compaction divider — behaviors 3,4,7,16", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page, "opencode")
    const trace = loadTrace("opencode", assistantId)
    await replay(mock, dir, trace, assistantInfo)

    const content = page.locator(assistantContent())

    // Delivery anchor (leading text shown even while folded), then unfold + open groups.
    await expect(content.getByText("Reading the config, then editing it.")).toBeVisible({ timeout: 45_000 })
    await revealTurn(page)

    // behavior 3/16: opencode's own native "apply_patch" tool reaches the dedicated
    // apply_patch renderer (single-file layout — filename visible). It is a LONE work
    // tool here (preceded by the `skill` part, followed by the `compaction` part) so it
    // stays a standalone tool row rather than folding into a work group.
    await expect(content.locator('[data-slot="apply-patch-filename"], [data-slot="message-part-title-filename"]', { hasText: "app.ts" }).first()).toBeVisible({ timeout: 45_000 })

    // behavior 4: a deliberately-unregistered tool name (`custom_mcp_tool`, in none of
    // the context/work/hidden vocabularies) still falls back to GenericTool — the raw
    // tool string appears verbatim in the title, and the subtitle is the first matching
    // literal input field.
    await expect(content.locator('[data-slot="basic-tool-tool-title"]', { hasText: "custom_mcp_tool" })).toBeVisible()
    await expect(content.locator('[data-slot="basic-tool-tool-subtitle"]', { hasText: "vector search" })).toBeVisible()
  })

  // behavior 7 (compaction divider). Root cause found via live store inspection (NOT the
  // session-turn.tsx collision the prior note guessed): the assistant `compaction` part
  // was dropped in the raw-Part<->UIMessage projection. `opencodePartToChatParts`
  // (opencode-conversation.ts) had no "compaction" case, so — exactly like the "agent"
  // and "file" gaps — the part never entered the TanStack UIMessage and thus never
  // reached `getMsgParts`/`renderablePart`/`PART_MAPPING["compaction"]`. Fixed by adding
  // the lossless compaction round-trip to the projection (both directions).
  test("renderer-only canonical fixture — compaction divider renders on the assistant timeline — behavior 7", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page, "opencode")
    const trace = loadTrace("opencode", assistantId)
    await replay(mock, dir, trace, assistantInfo)

    const content = page.locator(assistantContent())
    await expect(content.getByText("Reading the config, then editing it.")).toBeVisible({ timeout: 45_000 })
    await revealTurn(page)

    // The assistant `compaction` part reaches its dedicated divider renderer
    // (PART_MAPPING["compaction"] -> MessageDivider) inline in the assistant timeline —
    // distinct from session-turn.tsx's separate user-message compaction TurnDivider.
    await expect(content.locator('[data-component="compaction-part"] [data-slot="compaction-part-divider"]')).toBeVisible({ timeout: 45_000 })
  })

  test("renderer-only canonical fixture — question tool hidden while pending, visible once answered — behavior 10", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page, "opencode")
    const trace = loadTrace("opencode", assistantId)
    await replay(mock, dir, trace, assistantInfo) // ends with the question part PENDING

    const content = page.locator(assistantContent())
    const questionText = "Which environment should I target?"

    // Delivery anchor, then fully unfold/expand the turn so the pending-question absence
    // below is proven by `renderable`'s pending-hide (message-timeline.data.ts) — NOT
    // merely by the turn fold hiding every tool.
    await expect(content.getByText("Reading the config, then editing it.")).toBeVisible({ timeout: 45_000 })
    await revealTurn(page)

    // Pending: the whole tool-part-wrapper is absent, not merely visually hidden, even
    // with the turn revealed.
    await expect(content.getByText(questionText)).toHaveCount(0)
    await expect(content.locator('[data-component="question-answers"]')).toHaveCount(0)

    // Answer it — the fixture file's dedicated "questionAnswered" envelope.
    const fixture = loadFixtureFile("opencode", assistantId) as { questionAnswered: Envelope }
    mock.emit(fixture.questionAnswered.payload as never, fixture.questionAnswered.directory || dir)

    // The answered question mounts as a new standalone part in the (already unfolded)
    // turn; revealTurn again in case the added part re-crossed the fold threshold.
    await revealTurn(page)
    await expect(content.getByText(questionText)).toBeVisible({ timeout: 45_000 })
    await expect(content.locator('[data-component="question-answers"]')).toBeVisible()
    await expect(content.locator('[data-slot="answer-text"]', { hasText: "staging" })).toBeVisible()
  })

  test("renderer-only canonical fixture — todowrite never renders a tool row — behavior 9", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page, "opencode")
    const content = page.locator(assistantContent())
    const before = await content.locator('[data-component="tool-part-wrapper"]').count()

    mock.emit(
      { type: "message.part.updated", properties: { sessionID: `ses_harness_matrix_opencode`, time: 999, part: { id: "msg_assistant_1-todo", sessionID: "ses_harness_matrix_opencode", messageID: assistantId, type: "tool", callID: "tool-todo-x", tool: "todowrite", state: { status: "completed", input: { todos: [{ content: "Ship it", status: "completed" }] }, output: "", title: "todowrite", metadata: {}, time: { start: 1, end: 2 } } } } } as never,
      dir,
    )
    mock.emit({ type: "todo.updated", properties: { sessionID: "ses_harness_matrix_opencode", todos: [{ id: "0", content: "Ship it", status: "completed" }] } } as never, dir)

    // Deterministic wait: poll the request log (todo route or SSE) plus the DOM count
    // stays put — not a bare sleep (INVARIANTS.md authoring rule #3).
    await expect(content.getByText("Ship it")).toHaveCount(0)
    await expect.poll(async () => content.locator('[data-component="tool-part-wrapper"]').count(), { timeout: 20_000 }).toBe(before)
  })

  test("renderer-only canonical fixture — tool lifecycle pending -> running -> completed -> error — behavior 5", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page, "opencode")
    const fixture = loadFixtureFile("opencode", assistantId) as { lifecycle: Record<"pending" | "running" | "completed" | "error", Envelope> }
    const content = page.locator(assistantContent())

    mock.emit(fixture.lifecycle.pending.payload as never, fixture.lifecycle.pending.directory || dir)
    const row = content.locator('[data-component="tool-part-wrapper"]').filter({ has: page.locator('[data-slot="basic-tool-tool-title"]') }).last()
    await expect(row).toBeVisible({ timeout: 30_000 })
    await expect(content.getByText("bun test")).toHaveCount(0) // pending: command hidden

    mock.emit(fixture.lifecycle.running.payload as never, fixture.lifecycle.running.directory || dir)
    await expect(content.getByText("bun test")).toHaveCount(0) // still running: still hidden

    mock.emit(fixture.lifecycle.completed.payload as never, fixture.lifecycle.completed.directory || dir)
    await expect(content.getByText("bun test")).toBeVisible({ timeout: 30_000 }) // completed: command visible

    mock.emit(fixture.lifecycle.error.payload as never, fixture.lifecycle.error.directory || dir)
    // error card replaces the tool body (`ToolErrorCard`,
    // packages/session-ui/src/components/tool-error-card.tsx) — closed by
    // default (`defaultOpen ?? false`), so its `state.error` detail text only
    // reaches the DOM/becomes visible once its own `Collapsible.Trigger` is
    // expanded.
    const errorTrigger = content.locator('[data-component="tool-trigger"]').filter({ has: page.locator('[data-component="tool-error-card-icon"]') }).last()
    await expect(errorTrigger).toBeVisible({ timeout: 30_000 })
    await errorTrigger.click()
    await expect(content.getByText("exit code 1")).toBeVisible({ timeout: 30_000 })
  })

  test("renderer-only canonical fixture — session.diff routes to the diff cache, never a phantom message row — behavior 8", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page, "opencode")
    const content = page.locator(assistantContent())
    const before = await content.locator('[data-component="tool-part-wrapper"], [data-component="text-part"], [data-component="reasoning-part"]').count()

    const fixture = loadFixtureFile("opencode", assistantId) as { sessionDiff: Envelope }
    mock.emit(fixture.sessionDiff.payload as never, fixture.sessionDiff.directory || dir)

    await expect.poll(
      async () => content.locator('[data-component="tool-part-wrapper"], [data-component="text-part"], [data-component="reasoning-part"]').count(),
      { timeout: 20_000 },
    ).toBe(before)
    expect(nonBackgroundNoiseConsole(mock.requests.console.filter((line) => /error/i.test(line)))).toEqual([])
  })

  test("pi — shares the native rendering path (text renders) — behavior 1", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page,"pi")
    const trace = loadTrace("pi", assistantId)
    await replay(mock, dir, trace, assistantInfo)

    const content = page.locator(assistantContent())
    await expect(content.getByText("Reading the config, then editing it.")).toBeVisible({ timeout: 45_000 })
  })

  // behavior 3 (pi's "one dedicated tool renderer" half): the regenerated pi
  // trace now carries a `read` tool envelope (fixture `main[3]`, produced by
  // `generate-harness-fixtures.ts`'s `opencodeNativeTrace("pi").slice(0, 4)` —
  // NOT hand-authored, satisfying DoD #4). It proves a Pi tool part reaches its
  // dedicated ToolRegistry `read` renderer, exactly like the other native
  // harnesses: even a single context-group tool renders inside the
  // closed-by-default `ContextToolGroup` collapsible, so `revealTurn` opens it.
  test("pi — one dedicated tool renderer (config.json subtitle) — behavior 3", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page,"pi")
    const trace = loadTrace("pi", assistantId)
    await replay(mock, dir, trace, assistantInfo)

    const content = page.locator(assistantContent())
    // Delivery anchor: the leading text lands (shared native path) before we unfold.
    await expect(content.getByText("Reading the config, then editing it.")).toBeVisible({ timeout: 45_000 })
    await revealTurn(page)

    // The `read` tool reaches its dedicated renderer — subtitle = the read path.
    await expect(
      content.locator('[data-slot="basic-tool-tool-subtitle"]', { hasText: "config.json" }).first(),
    ).toBeVisible({ timeout: 45_000 })
  })

  test("claude-acp — text dedup, Terminal->bash, read, todowrite hidden, unbound Task omitted — behaviors 1,3,9,15,16", async ({ page }) => {
    // The longest trace in the matrix; on CI's 2-core runners the replay alone
    // crowds the 60s default and the run dies mid-revealTurn. slow() = 3x.
    test.slow()
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page,"claude-acp")
    const trace = loadTrace("claude-acp", assistantId)
    await replay(mock, dir, trace, assistantInfo)

    const content = page.locator(assistantContent())

    // behavior 1: delta ACCUMULATION — the fixture's two deltas ('Building the ' +
    // 'feature now.') concatenate to the final text once, with no re-appended prefix.
    // NOT snapshot dedup: the adapter already converted the raw cumulative snapshots
    // ("Building the " / "Building the feature now.",
    // generate-harness-fixtures.ts:155,160) into these incremental deltas upstream — see
    // the FIXTURE PRE-BAKING note in the SPEC block.
    // (Leading text part, shown even while the rest of the turn is folded — the
    // delivery anchor before we unfold.)
    await expect(content.getByText("Building the feature now.", { exact: true })).toBeVisible({ timeout: 45_000 })
    await expect(content.getByText("Building the Building the", { exact: false })).toHaveCount(0)

    // SESSION-TIMELINE REDESIGN: unfold the turn and open its groups.
    await revealTurn(page)

    // behavior 16: the fixture's `part.tool: "bash"` (the ACP registry already mapped
    // Claude's raw "Terminal" title upstream — the raw string is NOT in the fixture, see
    // FIXTURE PRE-BAKING) dispatches to the bash renderer. A LONE work tool (between the
    // text and the read), so it stays a standalone row whose command subtitle is visible.
    // Converged, not asserted once — same rationale and pattern as the cursor-acp
    // test's lone-row poll below: a late re-render can re-collapse the fold AFTER
    // revealTurn returns, hiding this row until re-revealed.
    await expect
      .poll(
        async () => {
          const visible = await content.getByText("printf hi").isVisible().catch(() => false)
          if (visible) return true
          await revealTurn(page)
          return content.getByText("printf hi").isVisible().catch(() => false)
        },
        { timeout: 30_000 },
      )
      .toBe(true)

    // behavior 3: the fixture's `part.tool: "read"` (raw "Read File" already normalized
    // upstream) hits the dedicated read renderer. Even a SINGLE context-group tool renders inside
    // the closed-by-default `ContextToolGroup` collapsible (opened by `revealTurn`).
    await expect(content.locator('[data-slot="basic-tool-tool-subtitle"]', { hasText: "index.ts" })).toBeVisible()

    // behavior 15: fixture translation alone carries no authoritative host spawn edge,
    // so it renders no subagent surface. The U13 matrix below supplies the durable host
    // association and proves the open path.
    await expect(content.getByText("Review the auth module")).toHaveCount(0)

    // behavior 9: "Update TODOs" never became a tool row.
    await expect(content.getByText("Ship the fix")).toHaveCount(0)
  })

  test("codex-acp — Permission fake tool routes to the dock (not a tool row); apply_patch resolves to edit; bash — behaviors 3,12,16", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page,"codex-acp")
    const trace = loadTrace("codex-acp", assistantId)
    await replay(mock, dir, trace, assistantInfo)

    // behavior 12: the permission dock renders, driven by permission.asked.
    await expect(page.locator('[data-slot="permission-header-title"]')).toBeVisible({ timeout: 45_000 })
    const content = page.locator(assistantContent())

    // SESSION-TIMELINE REDESIGN: the apply_patch->edit and the bash are two consecutive
    // "work" tools, so they fold into ONE closed-by-default work group (summary "Edited 1
    // file · ran 1 command"); open it so each member's own row is reachable.
    await expect(content.locator('[data-component="work-group-trigger"]')).toBeVisible({ timeout: 45_000 })
    await revealTurn(page)

    // behavior 16 (finding, pinned as real): apply_patch resolves to the generic
    // "edit" renderer (filename visible), not a dedicated apply-patch-tool component.
    await expect(content.locator('[data-slot="message-part-title-filename"]', { hasText: "app.ts" })).toBeVisible()
    await expect(page.locator('[data-component="apply-patch-tool"]')).toHaveCount(0)

    // behavior 3: bash via kind-only classification.
    await expect(content.getByText("git status")).toBeVisible()

    // behavior 12 (exact proof, not vacuous): exactly the 2 REAL tool parts (the
    // apply_patch->edit and the bash, now the two members of the opened work group) ever
    // became tool-part-wrapper rows — the Permission tool_call never added a 3rd.
    await expect(content.locator('[data-component="tool-part-wrapper"]')).toHaveCount(2)
  })

  test("cursor-acp — full-text snapshot dedup, WritableIterable sentinel swallowed, Terminal->bash, Task omitted, todowrite hidden — behaviors 9,13,14,15,16", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page,"cursor-acp")
    const trace = loadTrace("cursor-acp", assistantId)
    await replay(mock, dir, trace, assistantInfo)

    const content = page.locator(assistantContent())

    // behavior 13: the fixture's incremental deltas ('A' then '1' — the adapter's
    // post-dedup output for the raw "A"/"A1" snapshots at
    // generate-harness-fixtures.ts:317-318) accumulate to "A1" exactly once, no "AA1".
    // The dedup itself happened upstream; see the FIXTURE PRE-BAKING note.
    // (Leading text — the delivery anchor before we unfold.)
    await expect(content.getByText("A1", { exact: true })).toBeVisible({ timeout: 45_000 })
    await expect(content.getByText("AA1")).toHaveCount(0)

    // behavior 14: the "Error: RetriableError: WritableIterable is closed" transport tail.
    // The DOM assertion alone is VACUOUS — `grep -c WritableIterable
    // e2e/fixtures/harness-traces/cursor-acp.json` is 0, so the string is not in the
    // replayed trace and `toHaveCount(0)` would pass on a blank page. The swallow happens
    // UPSTREAM (`isCursorWritableIterableTail`, agent-event-runtime
    // harnesses/acp/translate-session-update.ts:152,216-223), and the generator DOES feed
    // the raw chunk through the real adapter (generate-harness-fixtures.ts:324) — so the
    // discriminating proof available to a fixture replay is that the TRANSLATED trace
    // carries no trace of the sentinel. Fixtures are regenerated by script, so an adapter
    // regression that stopped swallowing it would fail HERE at the next regeneration.
    expect(JSON.stringify(trace), "the translated cursor-acp trace must not carry the swallowed transport tail").not.toContain(
      "WritableIterable",
    )
    // Corollary (kept, but not the proof): nothing renders it either.
    await expect(page.getByText("WritableIterable is closed")).toHaveCount(0)

    // SESSION-TIMELINE REDESIGN: unfold the turn and open its groups.
    await revealTurn(page)

    // behavior 16: the fixture's `part.tool: "bash"` (Cursor's raw "Terminal" title was
    // normalized upstream — see FIXTURE PRE-BAKING) hits the bash renderer. A LONE work
    // tool -> standalone row, command visible. Converged, not asserted once:
    // revealTurn's own header documents that late part updates can re-collapse the
    // fold AFTER the converge returns, and this lone-row assertion sits exactly in
    // that window — it flaked ~1/3 under load (CI shard 4, and locally under
    // --repeat-each). Re-converge until the row is visible, same pattern as the
    // helper itself.
    await expect
      .poll(
        async () => {
          const visible = await content.getByText("ls", { exact: true }).isVisible().catch(() => false)
          if (visible) return true
          await revealTurn(page)
          return content.getByText("ls", { exact: true }).isVisible().catch(() => false)
        },
        { timeout: 20_000, intervals: [250, 500, 1_000] },
      )
      .toBe(true)

    // behavior 15: Cursor ACP exposes no authoritative host association, so it renders
    // no subagent surface instead of manufacturing a transcript identity from tool state.
    await expect(content.getByText("Investigate flaky test")).toHaveCount(0)

    // behavior 9: "Update TODOs" never became a tool row.
    await expect(content.getByText("Fix flake")).toHaveCount(0)
  })

  test("claude-sdk (native) — raw \"Grep\" falls back to GenericTool, TodoWrite hidden — behaviors 4,9", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page,"claude-sdk")
    const content = page.locator(assistantContent())
    const trace = loadTrace("claude-sdk", assistantId)
    await replay(mock, dir, trace, assistantInfo)

    // behavior 4: raw native "Grep" (capitalized) does not match the "grep"
    // ToolRegistry key -> GenericTool fallback, raw name verbatim in the title.
    await expect(content.locator('[data-slot="basic-tool-tool-title"]', { hasText: "Grep" })).toBeVisible({ timeout: 45_000 })

    // behavior 9: TodoWrite intercepted before ever becoming a tool-start.
    await expect(content.getByText("Ship it", { exact: true })).toHaveCount(0)
  })

  // behaviors 2/17 (reasoning renders; diagnostics add zero extra rows). The reasoning
  // part is NOT undiagnosable as the prior remediation note assumed: live store
  // inspection proved the message.part.updated(text:"")+message.part.delta pair flows
  // correctly through the raw-Part<->UIMessage projection (opencode-conversation.ts maps
  // reasoning->thinking, accumulates the delta, and projects back to a reasoning Part
  // carrying the full text — verified via the projection log). The part reaches
  // `getMsgParts`, but `renderablePart(part, showReasoning)`
  // (message-timeline.data.ts) gates every reasoning part behind
  // `settings.general.showReasoningSummaries()`, which DEFAULTS TO FALSE
  // (src/platform/settings/provider.tsx) — reasoning summaries are opt-in. So the render
  // is correct; it only shows once the user enables the setting, which this test does
  // via the real settings UI before asserting.
  test("claude-sdk (native) — reasoning part renders, diagnostics add zero extra rows — behaviors 2,17", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page,"claude-sdk")
    const trace = loadTrace("claude-sdk", assistantId)
    await replay(mock, dir, trace, assistantInfo)

    await enableReasoningSummaries(page)

    const content = page.locator(assistantContent())
    await revealTurn(page)

    // behavior 2: the reasoning part (message.part.updated text:"" + message.part.delta)
    // reaches its dedicated renderer once reasoning summaries are on. It mounts as a
    // collapsed "Thought" accordion — expanding it reveals the delta-accumulated text.
    const reasoning = content.locator('[data-component="reasoning-part"]')
    await expect(reasoning).toBeVisible({ timeout: 45_000 })
    // Expand until the detail is actually revealed: a single click can land
    // mid-mount while the delta text is still streaming and get swallowed by
    // a re-render, leaving the accordion collapsed for the whole wait
    // (run 369). Visible text short-circuits, so an open accordion is never
    // toggled shut.
    await expect(async () => {
      const detail = content.getByText("Let me check the grep results.")
      if (await detail.isVisible()) return
      await reasoning.locator('[data-component="tool-trigger"], [data-slot="basic-tool-tool-title"]').first().click()
      await expect(detail).toBeVisible({ timeout: 3_000 })
    }).toPass({ timeout: 45_000 })

    // behavior 17: the trailing runtime.diagnostic envelope (a claude_sdk.unmapped_event
    // diagnostic, not a Part) adds no timeline row of its own — the assistant turn's
    // rendered content is exactly the reasoning part, the text part, and the one Grep
    // tool row, with no phantom diagnostic/error row.
    await expect(content.getByText("Searching the repo.")).toBeVisible()
    await expect(content.locator('[data-component="reasoning-part"]')).toHaveCount(1)
    await expect(content.locator('[data-component="tool-part-wrapper"]')).toHaveCount(1)
    await expect(content.locator('[data-component="tool-error-card"]')).toHaveCount(0)
  })

  test("codex-app-server (native) — proposed plan renders as plain text, \"command\" normalizes to the bash renderer — behaviors 4,11,17", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page,"codex-app-server")
    const trace = loadTrace("codex-app-server", assistantId)
    await replay(mock, dir, trace, assistantInfo)

    const content = page.locator(assistantContent())

    // behavior 11: the plan stream is ordinary paced text — no plan-specific
    // component/dock exists, so it shows up as literal markdown text.
    await expect(content.getByText("inspect tests")).toBeVisible({ timeout: 45_000 })
    await expect(content.getByText("run suite")).toBeVisible()

    // behavior 4 (SESSION-TIMELINE REDESIGN): the harness-native `command` tool name is
    // now normalized INTO the bash/shell renderer (the literal command shows in
    // `shell-submessage-value`; the title shimmer reads "Ran"), NOT the generic MCP
    // fallback it hit before this redesign — so no `basic-tool-tool-title` carries the
    // raw "command" string. A lone work tool, so it stays a standalone visible row.
    await expect(content.locator('[data-slot="shell-submessage-value"]', { hasText: "git status" })).toBeVisible()
    await expect(content.locator('[data-slot="basic-tool-tool-title"]', { hasText: "command" })).toHaveCount(0)
  })

  test("cursor-sdk (native) — assistant snapshot dedup, \"shell\" normalizes to the bash renderer, updateTodos hidden — behaviors 1,4,9", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page,"cursor-sdk")
    const trace = loadTrace("cursor-sdk", assistantId)
    await replay(mock, dir, trace, assistantInfo)

    const content = page.locator(assistantContent())

    // behavior 1: the fixture's deltas 'Hel' + 'lo there' (the adapter's post-dedup
    // output for the raw "Hel"/"Hello there" snapshots, generate-harness-fixtures.ts:
    // 350-351) accumulate to "Hello there" once, no "HelHello" — see FIXTURE PRE-BAKING.
    await expect(content.getByText("Hello there", { exact: true })).toBeVisible({ timeout: 45_000 })
    await expect(content.getByText("HelHello")).toHaveCount(0)

    // behavior 4 (SESSION-TIMELINE REDESIGN): the harness-native `shell` tool name is now
    // normalized INTO the bash/shell renderer (literal command in `shell-submessage-value`,
    // title shimmer "Ran"), NOT the generic MCP fallback it hit before — so no
    // `basic-tool-tool-title` carries the raw "shell" string. A lone work tool -> a
    // standalone visible row.
    await expect(content.locator('[data-slot="shell-submessage-value"]', { hasText: "bun test" })).toBeVisible()
    await expect(content.locator('[data-slot="basic-tool-tool-title"]', { hasText: "shell" })).toHaveCount(0)

    // behavior 9: updateTodos intercepted, never a tool row.
    await expect(content.getByText("Ship adapter")).toHaveCount(0)
  })

  // U13 closes the cross-harness subagent loop at the translated runtime/UI
  // boundary. Adapter-level suites prove how each provider discovers the row;
  // these scenarios deliberately start from the durable host row plus canonical
  // `subagent-updated` event that every adapter feeds to the app. The association
  // is the explicit spawn edge (`toolCallId`), never tool metadata, session titles,
  // provider ids, or transcript refs.
  for (const input of subagentHarnessCases) {
    test(`subagents — ${input.name} ${input.openable ? "opens its child transcript" : "is explicitly unavailable"} — behavior 15`, async ({ page }) => {
      test.slow()
      const scenario = subagentScenario(input)
      const primed = await primeHarness(page, input.harness, scenario.fixture)
      await replay(
        primed.mock,
        primed.dir,
        [subagentTaskEnvelope({
          sessionId: primed.sessionId,
          assistantId: primed.assistantId,
          toolCallId: scenario.toolCallId,
          description: scenario.description,
        })],
        primed.assistantInfo,
      )

      const card = page.locator(
        `[data-component="task-tool-card"][data-subagent-key="${scenario.subagentKey}"]`,
      )
      await expect(card).toBeVisible({ timeout: 45_000 })
      await expect(card.locator('[data-slot="subagent-status"]')).toHaveText("Working")
      if (input.mode === "background") {
        await expect(card.locator('[data-slot="basic-tool-tool-subtitle"]')).toContainText(
          "Background · continues independently",
        )
      }

      completeSubagent(primed.mock, primed.dir, primed.sessionId, scenario.subagentKey)
      await expect(card.locator('[data-slot="subagent-status"]')).toHaveText("Completed", { timeout: 20_000 })

      const anchor = card.locator("xpath=ancestor::a[1]")
      if (!input.openable) {
        await expect(card.locator('[data-slot="basic-tool-tool-subtitle"]')).toContainText("Transcript unavailable")
        await expect(anchor).toHaveCount(0)
        await expect(card.locator('[data-component="task-tool-action"]')).toHaveCount(0)
        return
      }

      await expect(anchor).toHaveCount(1)
      await expect(card.locator('[data-component="task-tool-action"]')).toHaveCount(1)
      const closeWorkspacePanel = page.getByRole("button", { name: "Close workspace panel", exact: true })
      if (await closeWorkspacePanel.isVisible().catch(() => false)) await closeWorkspacePanel.click()
      await anchor.click()
      await expect(page.getByText(`child transcript for ${input.name}`, { exact: true })).toBeVisible({ timeout: 30_000 })
      await expectAssistantReplyVisible(page, `ack 1: matrix probe ${input.harness}`)
    })
  }

  test("subagents — narrow child surface is read-only and returns focus to its spawn card — behavior 15", async ({ page }) => {
    test.slow()
    await page.setViewportSize({ width: 700, height: 900 })
    const input = subagentHarnessCases.find((item) => item.name === "Canonical live transcript fixture")!
    const scenario = subagentScenario(input)
    const primed = await primeHarness(page, input.harness, scenario.fixture)
    await replay(
      primed.mock,
      primed.dir,
      [subagentTaskEnvelope({
        sessionId: primed.sessionId,
        assistantId: primed.assistantId,
        toolCallId: scenario.toolCallId,
        description: scenario.description,
      })],
      primed.assistantInfo,
    )

    const card = page.locator(
      `[data-component="task-tool-card"][data-subagent-key="${scenario.subagentKey}"]`,
    )
    const anchor = card.locator("xpath=ancestor::a[1]")
    await expect(anchor).toHaveCount(1)
    await anchor.focus()
    await page.keyboard.press("Enter")

    const childHeading = page.locator(`[data-session-timeline-session-id="${scenario.childSessionId}"] [data-subagent-child-heading]`)
    await expect(childHeading).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText("Subagent sessions cannot be prompted.", { exact: true })).toBeVisible()
    await expect(page.getByRole("textbox", { name: /Ask anything/i })).toHaveCount(0)
    const backToParent = page.getByRole("button", { name: "Back to main session.", exact: true })
    await expect(backToParent).toBeVisible()
    await backToParent.click()
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(anchor).toBeFocused()
    await expectAssistantReplyVisible(page, "ack 1: matrix probe opencode")
  })

  test("subagents — bare Pi capability emits no synthetic task card — behavior 15", async ({ page }) => {
    const { mock } = await primeHarness(page, "pi")
    await expect(page.locator('[data-component="task-tool-card"]')).toHaveCount(0)
    expect(mock.requests.badResponses).toEqual([])
  })

  test("subagents — unauthorized parent runtime stream is rejected before subscription — behavior 15", async ({ page }) => {
    await primeHarness(page, "opencode", {
      rows: [],
      runtimeEventAuthorizeParent: (parentSessionId) => parentSessionId !== "parent-denied",
    })
    const response = await page.evaluate(async () => {
      const result = await fetch("/api/wr/runtime-events?parentSessionId=parent-denied")
      return { status: result.status, body: await result.json() }
    })
    expect(response).toEqual({ status: 403, body: { error: "Forbidden" } })
  })

  // behavior 6: assistant `file`-type parts (image/audio data-url, resource links) now
  // reach a dedicated renderer. Previously the REAL GAP was two-layered: no
  // `PART_MAPPING["file"]` component existed (message-part.tsx) AND the app's
  // `renderablePart` (message-timeline.data.ts) excluded "file" from its renderable set,
  // so a `file`-type assistant part was dropped from `groupParts()` and never hit the
  // DOM. Fixed by registering `FilePartDisplay` (image inline + preview, audio player,
  // resource-link row) and adding "file" to the renderable set.
  test("assistant file-type parts (image/audio/resource-link) render — behavior 6", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page, "opencode")
    const sessionID = "ses_harness_matrix_opencode"
    const filePart = (id: string, mime: string, url: string, filename: string, source?: unknown) =>
      mock.emit(
        {
          type: "message.part.updated",
          properties: {
            sessionID,
            time: 900,
            part: { id, sessionID, messageID: assistantId, type: "file", mime, url, filename, ...(source ? { source } : {}) },
          },
        } as never,
        dir,
      )

    // 1x1 transparent PNG (image → inline + preview-on-click)
    filePart(
      "msg_assistant_1-file-image",
      "image/png",
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "shot.png",
    )
    // audio data-url (audio → <audio controls> player)
    filePart(
      "msg_assistant_1-file-audio",
      "audio/mpeg",
      "data:audio/mpeg;base64,SUQzAAAAAAAA",
      "clip.mp3",
    )
    // MCP resource link (neither image nor audio → link row)
    filePart(
      "msg_assistant_1-file-resource",
      "text/html",
      "https://example.com/report.html",
      "report.html",
      { type: "resource", clientName: "docs", uri: "https://example.com/report.html", text: { value: "", start: 0, end: 0 } },
    )

    const content = page.locator(assistantContent())

    // File parts are standalone (non-tool) groups — not foldable — so they render inline
    // without unfolding the turn.
    // Image: an inline <img> pointing at the data-url.
    const image = content.locator('[data-component="file-part"] img[data-slot="file-part-image"]')
    await expect(image).toBeVisible({ timeout: 45_000 })
    await expect(image).toHaveAttribute("src", /^data:image\/png;base64,/)

    // Audio: an <audio controls> element.
    await expect(content.locator('[data-component="file-part"] audio[data-slot="file-part-audio"]')).toHaveCount(1)

    // Resource link: an anchor row carrying the resource href + filename.
    const link = content.locator('[data-component="file-part"] a[data-slot="file-part-link"]')
    await expect(link).toBeVisible()
    await expect(link).toHaveAttribute("href", "https://example.com/report.html")
    await expect(link.locator('[data-slot="file-part-link-name"]')).toHaveText("report.html")
  })
})
