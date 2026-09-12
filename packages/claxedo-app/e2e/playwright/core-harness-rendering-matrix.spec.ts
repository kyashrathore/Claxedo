/**
 * Renderer-only replay of canonical presentation fixtures.
 *
 * These tests inject already-projected message parts, so they cover timeline
 * renderers, lifecycle updates, and dock presentation — not adapter translation,
 * auth, or connectivity. A fixture name records where a trace came from, not what
 * that provider advertises today. Protocol coverage lives in the adapter tests in
 * packages/opencode-server-adapter.
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
 * Normalizes every `messageID` in a trace onto the primed assistant row id.
 *
 * The client attaches a part only when its `messageID` matches the row id, and a
 * mismatched part is accepted silently and never rendered — so the whole trace goes
 * invisible. ACP fixtures carry two ids (`msg_assistant_1` on lifecycle envelopes,
 * the adapter's own `"message-1"` on every `message.part.*`), and the live row id
 * follows the production `${userMessageID}_r` shape either way. The rewrite happens
 * in memory: the committed fixtures are script-generated and never hand-edited.
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
 * Drops the console noise from the always-on central-relay probe. That connection is
 * session-independent, targets 127.0.0.1:3001, and is outside every same-origin route
 * mock here, so it logs connection-refused with no backend running. Uncaught
 * `pageerror:` entries are not filtered.
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
 * Trace-fixture family -> the harness identity the app and the runtime speak.
 *
 * Two DIFFERENT vocabularies meet in this spec and must not be conflated:
 *   - the fixture family name (`claude-acp`), which names a recorded trace under
 *     `e2e/fixtures/harness-traces/` and is baked into that trace's `directory`
 *     and `sessionID` strings — regenerating is the only way to change it, and
 *     the committed traces are the frozen evidence these tests replay;
 *   - the harness IDENTITY the mock runtime is installed with, which is the
 *     mock runtime's fixture key (`connectionIdFor` in e2e/helpers/mock-runtime.ts
 *     maps it to a connection id). The real validator, `normalizeHarnessIdentity`
 *     (agent-sdk-runtime/src/harness-types.ts), does not accept colon-form ids.
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
    // A draft has no default model, so opencode needs a catalog entry to select.
    ...(harness === "opencode" ? { harnessModels: { opencode: [{ id: "gpt-5", name: "GPT-5" }] } } : {}),
  })
  await seedOneProject(page, dir)

  await page.goto(`/${slug(dir)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

  // A draft has no implicit agent; there is no fallback, so pick one explicitly.
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

  // A completed assistant message rejects part events for part ids it does not already
  // have (`settledAssistantMessage`, opencode-conversation.ts), so the row must be open
  // before any fixture part arrives. Wait for `time.completed` first — reply visibility
  // races driveTurn's settle — then re-open once, which also covers the tests that emit
  // parts directly instead of through `replay`.
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
 * Replays a fixture trace onto the primed assistant row, bracketed by a re-open (the
 * same info with `time.completed` stripped) and a re-settle with the original info,
 * because a settled row rejects parts it does not already hold.
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

/**
 * The chip a subagent row renders as, and — separately — the same chip as an
 * activatable control. An unopenable subagent draws a `<span>`, so the tag is the
 * assertion that separates "shown" from "can be opened".
 */
function subagentChip(page: Page, subagentKey: string) {
  const within = (tag: string) =>
    `[data-component="subagent-chip-row"] ${tag}[data-component="subagent-chip"][data-subagent-key="${subagentKey}"]`
  return { chip: page.locator(within("")), openControl: page.locator(within("button")) }
}

/** The workspace-panel tab a chip opens, addressed by the child session it holds. */
function subagentTab(page: Page, childSessionId: string) {
  return page.locator(
    `[data-slot="workspace-tab"][data-workspace-tab-kind="subagent"][data-workspace-tab-id="subagent:${childSessionId}"]`,
  )
}

/** The one panel body the user is looking at; retained bodies are marked inert. */
function workspacePanelBody(page: Page) {
  return page.locator('[data-testid="workspace-panel-body"]:not([data-panel-body-inert="true"])')
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
  // `subagent-updated` travels on `/api/wr/runtime-events` only, both in the runtime
  // and in the app. `emitRuntime` publishes there; `emitFlat` would put the frame on
  // compat channels where nothing applies it.
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
 * Reasoning summaries are opt-in and off by default, and `renderablePart`
 * (`message-timeline.data.ts`) drops every reasoning part while the setting is off. The
 * setting is reactive, so parts that already streamed appear once the dialog closes.
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
 * Opens an assistant turn until every tool's own detail slot is reachable.
 *
 * The timeline collapses in two places. A turn with more than a couple of part groups
 * hides its middle groups behind a `[data-component="turn-fold"]` toggle, and two or
 * more consecutive work tools (bash/edit/webfetch/websearch families) fold into one
 * closed `[data-component="work-group-trigger"]` collapsible. A lone work tool stays a
 * standalone `[data-component="tool-part-wrapper"]` row with its subtitle visible.
 */
async function revealTurn(page: Page) {
  // The fold races the replay in both directions: it can mount a beat after the leading
  // text renders, and a late part update can re-cross the threshold and re-collapse it,
  // unmounting group triggers mid-expansion. Converge instead of clicking once.
  const fold = page.locator('[data-component="turn-fold"] button').first()
  const toolDom = page.locator(
    '[data-component="tool-part-wrapper"], [data-component="work-group-trigger"], [data-component="context-tool-group-trigger"], [data-component="subagent-chip-row"]',
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
        // The fold can mount closed just after the tools render, so hold the condition
        // across a gap and re-open before the verdict.
        await page.waitForTimeout(350)
        await foldOpen()
        return toolDom.isVisible().catch(() => false)
      },
      { timeout: 30_000, intervals: [250, 500, 1_000] },
    )
    .toBe(true)
  // A lone work tool has no trigger — its subtitle is already visible.
  for (const sel of ['[data-component="work-group-trigger"]', '[data-component="context-tool-group-trigger"]']) {
    const triggers = page.locator(sel)
    for (let i = 0; i < (await triggers.count()); i++) {
      const trigger = triggers.nth(i)
      // `aria-expanded` sits on the Collapsible button wrapping this trigger, never on
      // the trigger itself. Read the state before each click so an open group is not
      // toggled shut, and re-open the fold in case a re-render hid the trigger.
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
  test("renderer-only canonical fixture — dedicated ToolRegistry renderers for read/list/glob/webfetch/websearch/write/skill", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page, "opencode")
    const trace = loadTrace("opencode", assistantId)
    await replay(mock, dir, trace, assistantInfo)

    const content = page.locator(assistantContent())

    // Delivery anchor: a leading text part renders even while the turn is folded, so
    // its arrival proves the trace reached the store before anything is unfolded.
    await expect(content.getByText("Reading the config, then editing it.")).toBeVisible({ timeout: 45_000 })

    await revealTurn(page)

    await expect(content.locator('[data-component="context-tool-group-list"]').first()).toBeVisible({ timeout: 10_000 })

    await expect(content.locator('[data-slot="basic-tool-tool-subtitle"]', { hasText: "config.json" }).first()).toBeVisible({ timeout: 45_000 })
    // A grouped context tool has no `data-timeline-part-id` of its own; only the group
    // wrapper carries the comma-joined `data-timeline-part-ids`.
    await expect(content.locator('[data-timeline-part-ids*="msg_assistant_1-list"]')).toBeVisible({ timeout: 45_000 })
    await expect(content.locator('[data-slot="basic-tool-tool-arg"]', { hasText: "pattern=**/*.json" })).toBeVisible()
    await expect(content.getByRole("link", { name: "https://example.com/docs" })).toBeVisible()
    await expect(content.getByText("opencode config schema")).toBeVisible()
    await expect(content.locator('[data-slot="message-part-title-filename"]', { hasText: "config.json" })).toBeVisible()
    // The skill title is `input.name` untranslated, but the slot capitalizes it in CSS,
    // so the rendered text reads "Pdf" for the lowercase "pdf" — match case-insensitively.
    await expect(content.locator('[data-slot="basic-tool-tool-title"]').filter({ hasText: /pdf/i })).toBeVisible()
  })

  test("renderer-only canonical fixture — apply_patch dedicated renderer, GenericTool fallback, compaction divider", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page, "opencode")
    const trace = loadTrace("opencode", assistantId)
    await replay(mock, dir, trace, assistantInfo)

    const content = page.locator(assistantContent())

    // Delivery anchor (leading text shown even while folded), then unfold + open groups.
    await expect(content.getByText("Reading the config, then editing it.")).toBeVisible({ timeout: 45_000 })
    await revealTurn(page)

    // Native `apply_patch` reaches its dedicated single-file renderer. It sits between
    // the skill and compaction parts, so it is a lone work tool with no group of its own.
    await expect(content.locator('[data-slot="apply-patch-filename"], [data-slot="message-part-title-filename"]', { hasText: "app.ts" }).first()).toBeVisible({ timeout: 45_000 })

    // An unregistered tool name falls back to GenericTool, which reads the row as a
    // sentence (`humanizeTool`): the name becomes the action, the first matching input
    // field the subtitle. It is the tool name that survives, not its raw punctuation.
    await expect(content.locator('[data-slot="basic-tool-tool-title"]', { hasText: "Custom mcp tool" })).toBeVisible()
    await expect(content.locator('[data-slot="basic-tool-tool-subtitle"]', { hasText: "vector search" })).toBeVisible()
  })

  test("renderer-only canonical fixture — compaction divider renders on the assistant timeline", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page, "opencode")
    const trace = loadTrace("opencode", assistantId)
    await replay(mock, dir, trace, assistantInfo)

    const content = page.locator(assistantContent())
    await expect(content.getByText("Reading the config, then editing it.")).toBeVisible({ timeout: 45_000 })
    await revealTurn(page)

    // The assistant `compaction` part gets its own inline divider, which is a different
    // renderer from the user-message compaction divider in session-turn.tsx.
    await expect(content.locator('[data-component="compaction-part"] [data-slot="compaction-part-divider"]')).toBeVisible({ timeout: 45_000 })
  })

  test("renderer-only canonical fixture — question tool hidden while pending, visible once answered", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page, "opencode")
    const trace = loadTrace("opencode", assistantId)
    await replay(mock, dir, trace, assistantInfo) // ends with the question part PENDING

    const content = page.locator(assistantContent())
    const questionText = "Which environment should I target?"

    // Unfold fully, so the pending question's absence below comes from the renderer
    // hiding it rather than from the turn fold hiding every tool.
    await expect(content.getByText("Reading the config, then editing it.")).toBeVisible({ timeout: 45_000 })
    await revealTurn(page)

    // Pending: the whole tool-part-wrapper is absent, not merely visually hidden, even
    // with the turn revealed.
    await expect(content.getByText(questionText)).toHaveCount(0)
    await expect(content.locator('[data-component="question-answers"]')).toHaveCount(0)

    const fixture = loadFixtureFile("opencode", assistantId) as { questionAnswered: Envelope }
    mock.emit(fixture.questionAnswered.payload as never, fixture.questionAnswered.directory || dir)

    // The answer mounts as a new part, which can re-cross the fold threshold.
    await revealTurn(page)
    await expect(content.getByText(questionText)).toBeVisible({ timeout: 45_000 })
    await expect(content.locator('[data-component="question-answers"]')).toBeVisible()
    await expect(content.locator('[data-slot="answer-text"]', { hasText: "staging" })).toBeVisible()
  })

  test("renderer-only canonical fixture — todowrite never renders a tool row", async ({ page }) => {
    const { mock, dir, assistantId } = await primeHarness(page, "opencode")
    const content = page.locator(assistantContent())
    const before = await content.locator('[data-component="tool-part-wrapper"]').count()

    mock.emit(
      { type: "message.part.updated", properties: { sessionID: `ses_harness_matrix_opencode`, time: 999, part: { id: "msg_assistant_1-todo", sessionID: "ses_harness_matrix_opencode", messageID: assistantId, type: "tool", callID: "tool-todo-x", tool: "todowrite", state: { status: "completed", input: { todos: [{ content: "Ship it", status: "completed" }] }, output: "", title: "todowrite", metadata: {}, time: { start: 1, end: 2 } } } } } as never,
      dir,
    )
    mock.emit({ type: "todo.updated", properties: { sessionID: "ses_harness_matrix_opencode", todos: [{ id: "0", content: "Ship it", status: "completed" }] } } as never, dir)

    await expect(content.getByText("Ship it")).toHaveCount(0)
    await expect.poll(async () => content.locator('[data-component="tool-part-wrapper"]').count(), { timeout: 20_000 }).toBe(before)
  })

  test("renderer-only canonical fixture — tool lifecycle pending -> running -> completed -> error", async ({ page }) => {
    const { mock, dir, assistantId } = await primeHarness(page, "opencode")
    const fixture = loadFixtureFile("opencode", assistantId) as { lifecycle: Record<"pending" | "running" | "completed" | "error", Envelope> }
    const content = page.locator(assistantContent())

    // The command names the row from the first payload onwards. A call that sits on
    // "Running" for minutes while refusing to say which command it is running is the
    // defect this replaced; the input carries `command` well before the call returns.
    mock.emit(fixture.lifecycle.pending.payload as never, fixture.lifecycle.pending.directory || dir)
    const row = content.locator('[data-component="tool-part-wrapper"]').filter({ has: page.locator('[data-slot="basic-tool-tool-title"]') }).last()
    await expect(row).toBeVisible({ timeout: 30_000 })
    await expect(content.getByText("bun test")).toBeVisible({ timeout: 30_000 })

    mock.emit(fixture.lifecycle.running.payload as never, fixture.lifecycle.running.directory || dir)
    await expect(content.getByText("bun test")).toBeVisible({ timeout: 30_000 })

    mock.emit(fixture.lifecycle.completed.payload as never, fixture.lifecycle.completed.directory || dir)
    await expect(content.getByText("bun test")).toBeVisible({ timeout: 30_000 })

    mock.emit(fixture.lifecycle.error.payload as never, fixture.lifecycle.error.directory || dir)
    // The error card replaces the tool body and is closed by default, so `state.error`
    // reaches the DOM only after its own trigger is expanded.
    const errorTrigger = content.locator('[data-component="tool-trigger"]').filter({ has: page.locator('[data-component="tool-error-card-icon"]') }).last()
    await expect(errorTrigger).toBeVisible({ timeout: 30_000 })
    await errorTrigger.click()
    await expect(content.getByText("exit code 1")).toBeVisible({ timeout: 30_000 })
  })

  test("renderer-only canonical fixture — session.diff routes to the diff cache, never a phantom message row", async ({ page }) => {
    const { mock, dir, assistantId } = await primeHarness(page, "opencode")
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

  test("pi — shares the native rendering path (text renders)", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page,"pi")
    const trace = loadTrace("pi", assistantId)
    await replay(mock, dir, trace, assistantInfo)

    const content = page.locator(assistantContent())
    await expect(content.getByText("Reading the config, then editing it.")).toBeVisible({ timeout: 45_000 })
  })

  test("pi — one dedicated tool renderer (config.json subtitle)", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page,"pi")
    const trace = loadTrace("pi", assistantId)
    await replay(mock, dir, trace, assistantInfo)

    const content = page.locator(assistantContent())
    // Delivery anchor: the leading text lands (shared native path) before we unfold.
    await expect(content.getByText("Reading the config, then editing it.")).toBeVisible({ timeout: 45_000 })
    await revealTurn(page)

    await expect(
      content.locator('[data-slot="basic-tool-tool-subtitle"]', { hasText: "config.json" }).first(),
    ).toBeVisible({ timeout: 45_000 })
  })

  test("claude-acp — text dedup, Terminal->bash, read, todowrite hidden, unbound Task omitted", async ({ page }) => {
    // The longest trace here; on a 2-core runner the replay alone crowds the 60s default.
    test.slow()
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page,"claude-acp")
    const trace = loadTrace("claude-acp", assistantId)
    await replay(mock, dir, trace, assistantInfo)

    const content = page.locator(assistantContent())

    // The fixture's two deltas concatenate once, with no re-appended prefix. The
    // adapter turned the provider's cumulative snapshots into deltas before the trace
    // was recorded, so this checks accumulation, not snapshot dedup. Also the delivery
    // anchor: leading text renders while the turn is still folded.
    await expect(content.getByText("Building the feature now.", { exact: true })).toBeVisible({ timeout: 45_000 })
    await expect(content.getByText("Building the Building the", { exact: false })).toHaveCount(0)

    await revealTurn(page)

    // The ACP registry normalized Claude's raw "Terminal" title to `bash` before the
    // trace was recorded, so this dispatches to the bash renderer. It is a lone work
    // tool, hence a standalone row. Re-reveal inside the poll: a late re-render can
    // re-collapse the fold after `revealTurn` returns and hide the row again.
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

    // Raw "Read File" was normalized to `read` upstream, so this reaches the dedicated
    // read renderer.
    await expect(content.locator('[data-slot="basic-tool-tool-subtitle"]', { hasText: "index.ts" })).toBeVisible()

    // A translated trace carries no host spawn edge, so no subagent surface renders. The
    // subagents matrix below supplies that association.
    await expect(content.getByText("Review the auth module")).toHaveCount(0)

    // "Update TODOs" never becomes a tool row.
    await expect(content.getByText("Ship the fix")).toHaveCount(0)
  })

  test("codex-acp — Permission fake tool routes to the dock (not a tool row); apply_patch resolves to edit; bash", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page,"codex-acp")
    const trace = loadTrace("codex-acp", assistantId)
    await replay(mock, dir, trace, assistantInfo)

    // `permission.asked` drives the dock.
    await expect(page.locator('[data-slot="permission-header-title"]')).toBeVisible({ timeout: 45_000 })
    const content = page.locator(assistantContent())

    // apply_patch->edit and bash are consecutive work tools, so they share one group.
    await expect(content.locator('[data-component="work-group-trigger"]')).toBeVisible({ timeout: 45_000 })
    await revealTurn(page)

    await expect(content.locator('[data-slot="message-part-title-filename"]', { hasText: "app.ts" })).toBeVisible()
    await expect(page.locator('[data-component="apply-patch-tool"]')).toHaveCount(0)

    // bash is classified by kind alone.
    await expect(content.getByText("git status")).toBeVisible()

    // Only the two real tools become rows; the Permission tool_call never adds a third.
    await expect(content.locator('[data-component="tool-part-wrapper"]')).toHaveCount(2)
  })

  test("cursor-acp — full-text snapshot dedup, WritableIterable sentinel swallowed, Terminal->bash, Task omitted, todowrite hidden", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page,"cursor-acp")
    const trace = loadTrace("cursor-acp", assistantId)
    await replay(mock, dir, trace, assistantInfo)

    const content = page.locator(assistantContent())

    // The adapter deduped Cursor's cumulative snapshots into deltas before the trace was
    // recorded, so the deltas here must accumulate to "A1" once, not "AA1".
    await expect(content.getByText("A1", { exact: true })).toBeVisible({ timeout: 45_000 })
    await expect(content.getByText("AA1")).toHaveCount(0)

    // The generator feeds Cursor's "WritableIterable is closed" transport tail through
    // the real adapter, which swallows it. Asserting on the DOM alone would pass on a
    // blank page, so the discriminating check is that the translated trace carries no
    // sentinel — which fails here the next time fixtures are regenerated against an
    // adapter that stopped swallowing it.
    expect(JSON.stringify(trace), "the translated cursor-acp trace must not carry the swallowed transport tail").not.toContain(
      "WritableIterable",
    )
    // Corollary, not the proof: nothing renders it either.
    await expect(page.getByText("WritableIterable is closed")).toHaveCount(0)

    await revealTurn(page)

    // Cursor's raw "Terminal" title was normalized to `bash` upstream. It is a lone work
    // tool, hence a standalone row. Re-reveal inside the poll: a late part update can
    // re-collapse the fold after `revealTurn` returns, and this assertion sits in that
    // window.
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

    // Cursor ACP exposes no host association, so no subagent surface renders rather than
    // a transcript identity invented from tool state.
    await expect(content.getByText("Investigate flaky test")).toHaveCount(0)

    // "Update TODOs" never becomes a tool row.
    await expect(content.getByText("Fix flake")).toHaveCount(0)
  })

  test("claude-sdk (native) — capitalised \"Grep\" groups as search, TodoWrite hidden", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page,"claude-sdk")
    const content = page.locator(assistantContent())
    const trace = loadTrace("claude-sdk", assistantId)
    await replay(mock, dir, trace, assistantInfo)

    // The projection canonicalises `Grep` to `grep` at tool-start, so the trace's three
    // calls reach the real renderer and fold into one context group like their lowercase
    // peers — rather than three loud generic rows.
    await expect(content.locator('[data-component="context-tool-group-trigger"]')).toBeVisible({ timeout: 45_000 })

    // The distinguishing assertion: GenericTool titles a row "Called `Grep`". Asserting
    // the title text alone cannot tell the two renderers apart, because `ui.tool.grep`
    // is itself "Grep".
    await expect(content.getByText("Called", { exact: false })).toHaveCount(0)

    // TodoWrite is intercepted before it can become a tool-start.
    await expect(content.getByText("Ship it", { exact: true })).toHaveCount(0)
  })

  test("claude-sdk (native) — reasoning part renders, diagnostics add zero extra rows", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page,"claude-sdk")
    const trace = loadTrace("claude-sdk", assistantId)
    await replay(mock, dir, trace, assistantInfo)

    await enableReasoningSummaries(page)

    const content = page.locator(assistantContent())
    await revealTurn(page)

    // With summaries on, the reasoning part mounts as a collapsed "Thought" accordion;
    // its delta-accumulated text is behind the expander.
    const reasoning = content.locator('[data-component="reasoning-part"]')
    await expect(reasoning).toBeVisible({ timeout: 45_000 })
    // A single click can land mid-mount while the delta is still streaming and be
    // swallowed by a re-render. Visible text short-circuits, so an open accordion is
    // never toggled shut.
    await expect(async () => {
      const detail = content.getByText("Let me check the grep results.")
      if (await detail.isVisible()) return
      await reasoning.locator('[data-component="tool-trigger"], [data-slot="basic-tool-tool-title"]').first().click()
      await expect(detail).toBeVisible({ timeout: 3_000 })
    }).toPass({ timeout: 45_000 })

    // The trailing `runtime.diagnostic` envelope is not a Part, so the turn holds only
    // the reasoning part, the text, and the one Grep row.
    await expect(content.getByText("Searching the repo.")).toBeVisible()
    await expect(content.locator('[data-component="reasoning-part"]')).toHaveCount(1)
    await expect(content.locator('[data-component="tool-part-wrapper"]')).toHaveCount(1)
    await expect(content.locator('[data-component="tool-error-card"]')).toHaveCount(0)
  })

  test("codex-app-server (native) — proposed plan renders as plain text, \"command\" normalizes to the bash renderer", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page,"codex-app-server")
    const trace = loadTrace("codex-app-server", assistantId)
    await replay(mock, dir, trace, assistantInfo)

    const content = page.locator(assistantContent())

    // No plan-specific component exists, so a plan stream is ordinary markdown text.
    await expect(content.getByText("inspect tests")).toBeVisible({ timeout: 45_000 })
    await expect(content.getByText("run suite")).toBeVisible()

    // The native `command` tool name normalizes into the shell renderer, so the literal
    // command lands in `shell-submessage-value` and no title carries the raw name.
    await expect(content.locator('[data-slot="shell-submessage-value"]', { hasText: "git status" })).toBeVisible()
    await expect(content.locator('[data-slot="basic-tool-tool-title"]', { hasText: "command" })).toHaveCount(0)
  })

  test("cursor-sdk (native) — assistant snapshot dedup, \"shell\" normalizes to the bash renderer, updateTodos hidden", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page,"cursor-sdk")
    const trace = loadTrace("cursor-sdk", assistantId)
    await replay(mock, dir, trace, assistantInfo)

    const content = page.locator(assistantContent())

    // The adapter deduped Cursor's cumulative snapshots into deltas before the trace was
    // recorded, so the deltas here must accumulate to "Hello there" once, not "HelHello".
    await expect(content.getByText("Hello there", { exact: true })).toBeVisible({ timeout: 45_000 })
    await expect(content.getByText("HelHello")).toHaveCount(0)

    // The native `shell` tool name normalizes into the shell renderer, so the literal
    // command lands in `shell-submessage-value` and no title carries the raw name.
    await expect(content.locator('[data-slot="shell-submessage-value"]', { hasText: "bun test" })).toBeVisible()
    await expect(content.locator('[data-slot="basic-tool-tool-title"]', { hasText: "shell" })).toHaveCount(0)

    // updateTodos is intercepted and never becomes a tool row.
    await expect(content.getByText("Ship adapter")).toHaveCount(0)
  })

  // These scenarios start from the durable host row plus the `subagent-updated` event
  // every adapter feeds the app; how a provider discovers the row belongs to the adapter
  // suites. Parent and child are associated by the spawn edge (`toolCallId`) alone —
  // never by tool metadata, session title, provider id, or transcript ref.
  for (const input of subagentHarnessCases) {
    test(`subagents — ${input.name} ${input.openable ? "opens its child transcript" : "is explicitly unavailable"}`, async ({ page }) => {
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

      const { chip, openControl } = subagentChip(page, scenario.subagentKey)
      await expect(chip).toBeVisible({ timeout: 45_000 })
      await expect(chip).toHaveAttribute("data-status", "running")
      await expect(chip).toHaveAttribute("data-subagent-role", "spawn")
      await expect(chip.locator('[data-slot="subagent-chip-status"]')).toHaveText("working")

      completeSubagent(primed.mock, primed.dir, primed.sessionId, scenario.subagentKey)
      await expect(chip).toHaveAttribute("data-status", "completed", { timeout: 20_000 })
      await expect(chip.locator('[data-slot="subagent-chip-status"]')).toHaveText("done")

      if (!input.openable) {
        await expect(chip).toHaveAttribute("aria-label", /, transcript unavailable$/)
        await expect(openControl).toHaveCount(0)
        return
      }

      await expect(openControl).toHaveCount(1)
      // The tab is titled by the chip that opened it, so the chip's own name is the
      // expected label rather than a literal repeated from the fixture. Read as
      // `textContent`: the chip capitalises its name in CSS and the tab does not,
      // so `innerText` would compare the two surfaces' text-transform instead.
      const chipName = (await chip.locator('[data-slot="subagent-chip-name"]').textContent())!.trim()
      const closeWorkspacePanel = page.getByRole("button", { name: "Close workspace panel", exact: true })
      if (await closeWorkspacePanel.isVisible().catch(() => false)) await closeWorkspacePanel.click()
      await openControl.click()

      await expect(page.locator('[data-testid="workspace-panel-shell"]')).toHaveAttribute("data-open", "true", {
        timeout: 30_000,
      })
      const tab = subagentTab(page, scenario.childSessionId!)
      await expect(tab).toBeVisible({ timeout: 30_000 })
      await expect(tab).toHaveAttribute("data-selected", "true")
      await expect(tab).toContainText(chipName)

      const panel = workspacePanelBody(page)
      await expect(panel.locator(`[data-session-timeline-session-id="${scenario.childSessionId}"]`)).toBeVisible({
        timeout: 30_000,
      })
      await expect(panel.getByText(`child transcript for ${input.name}`, { exact: true })).toBeVisible({
        timeout: 30_000,
      })
      await expectAssistantReplyVisible(page, `ack 1: matrix probe ${input.harness}`)
    })
  }

  test("subagents — below the md boundary the child transcript still docks in the panel, read-only", async ({ page }) => {
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

    const { chip, openControl } = subagentChip(page, scenario.subagentKey)
    await expect(openControl).toHaveCount(1, { timeout: 45_000 })
    await openControl.focus()
    await page.keyboard.press("Enter")

    const shell = page.locator('[data-testid="workspace-panel-shell"]')
    await expect(shell).toHaveAttribute("data-open", "true", { timeout: 30_000 })
    await expect(subagentTab(page, scenario.childSessionId!)).toBeVisible({ timeout: 30_000 })

    const panel = workspacePanelBody(page)
    await expect(panel.locator(`[data-session-timeline-session-id="${scenario.childSessionId}"]`)).toBeVisible({
      timeout: 30_000,
    })
    await expect(panel.getByText(`child transcript for ${input.name}`, { exact: true })).toBeVisible()
    // Read-only: the docked child builds no composer at all, so this width owns no
    // prompt surface of its own and the parent pane keeps the page's only one.
    await expect(panel.locator(SELECTORS.submitControl)).toHaveCount(0)
    await expect(panel.getByRole("textbox", { name: /Ask anything/i })).toHaveCount(0)

    // The panel is a column beside the pane, not a route: the chip that opened it
    // is still mounted and still holds the keyboard.
    await expect(chip).toBeVisible()
    await expect(openControl).toBeFocused()
  })

  test("subagents — bare Pi capability emits no subagent chip row", async ({ page }) => {
    const { mock } = await primeHarness(page, "pi")
    await expect(page.locator('[data-component="subagent-chip-row"]')).toHaveCount(0)
    expect(mock.requests.badResponses).toEqual([])
  })

  test("subagents — unauthorized parent runtime stream is rejected before subscription", async ({ page }) => {
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

  test("assistant file-type parts (image/audio/resource-link) render", async ({ page }) => {
    const { mock, dir, assistantId } = await primeHarness(page, "opencode")
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

    // 1x1 transparent PNG
    filePart(
      "msg_assistant_1-file-image",
      "image/png",
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "shot.png",
    )
    filePart(
      "msg_assistant_1-file-audio",
      "audio/mpeg",
      "data:audio/mpeg;base64,SUQzAAAAAAAA",
      "clip.mp3",
    )
    // MCP resource link — neither image nor audio
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
    const image = content.locator('[data-component="file-part"] img[data-slot="file-part-image"]')
    await expect(image).toBeVisible({ timeout: 45_000 })
    await expect(image).toHaveAttribute("src", /^data:image\/png;base64,/)

    await expect(content.locator('[data-component="file-part"] audio[data-slot="file-part-audio"]')).toHaveCount(1)

    const link = content.locator('[data-component="file-part"] a[data-slot="file-part-link"]')
    await expect(link).toBeVisible()
    await expect(link).toHaveAttribute("href", "https://example.com/report.html")
    await expect(link.locator('[data-slot="file-part-link-name"]')).toHaveText("report.html")
  })
})
