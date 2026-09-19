/**
 * Renderer replay through presentation and canonical runtime event transports.
 *
 * Stored snapshots and retained streams are independent: a completed snapshot can
 * be followed by its earlier busy and tool-start events on a reattached stream.
 * Fixtures cover rendering and client projection, not provider binaries or auth.
 * A fixture name records where a trace came from, not what
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
  type MockMessageRow,
  type MockRuntimeSubagentRow,
} from "../helpers/mock-runtime"
import { ensureComposerModelSelected, expectAssistantReplyVisible, expectAssistantTextOccurrences, selectComposerAgent, SELECTORS } from "../helpers/turn-oracle"
import { sampleElementDuringAction, scrollTimelineToTop } from "../helpers/geometry-oracle"
import { expectRailRowVisible } from "../helpers/rail-oracle"
import { writeFile } from "node:fs/promises"

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
 *     (agent-runtime-contract's `harnesses.ts`), does not accept colon-form ids.
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
    workspaceStreamAuthorize?: (scope: { sessionID?: string }) => boolean
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
      workspaceStreamAuthorize: subagents.workspaceStreamAuthorize,
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
    ? "Claude Code"
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
  const description = `Delegate ${input.name}: review the current session virtualization implementation, including retained sessions, streaming events, transcript row identities, and canonical subagent lifecycle updates. Keep the review read-only and return concrete findings with file and line evidence.`
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
  return { chip: page.locator(within("")), openControl: page.locator(within(":is(button, a[href])")) }
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
  partId?: string
}) {
  return {
    directory: "",
    payload: {
      id: `message.part.updated:${input.assistantId}:${input.toolCallId}`,
      type: "message.part.updated",
      properties: {
        sessionID: input.sessionId,
        part: {
          id: input.partId ?? input.toolCallId,
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
  // A subagent revision is a runtime-channel event: the runtime projects it to
  // `subagent.updated` on `wr/events`, which is what `emitRuntime` models.
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
  test("a manually closed latest Codex turn stays closed when its settled frames arrive late", async ({ page }, testInfo) => {
    const fixture = JSON.parse(readFileSync(join(FIXTURES_DIR, "codex-completed-runtime-replay.json"), "utf-8")) as {
      messages: MockMessageRow[]; events: Array<Parameters<MockRuntimeHandles["emitRuntime"]>[0]>
    }
    const sessionId = fixture.messages[0].info.sessionID
    const userId = fixture.messages[0].info.id
    const otherId = "ses_fold_other"
    const dir = "/tmp/e2e-completed-fold-replay"
    const mock = await installMockRuntime(page, {
      dir, sessionId, projectId: PROJECT_ID, workspaceId: PROJECT_ID, harness: "codex-app-server",
      existingSession: { messages: fixture.messages },
      otherSessions: [{ id: otherId, title: "Other fold session", prompt: "Other prompt", reply: "Other completed reply" }],
    })
    await seedOneProject(page, dir)
    await page.goto(`/${slug(dir)}/session/${sessionId}`)
    await expectAssistantReplyVisible(page, "QA_FIRST_DONE_1164", { spec: "core-harness-rendering-matrix", scenario: `fold-before-${testInfo.repeatEachIndex}` })
    await scrollTimelineToTop(page)
    const foldSelector = `[data-message-id="${userId}"][data-timeline-row="TurnFold"] button`
    const fold = page.locator(foldSelector)
    await expect(fold).toBeVisible()
    if (await fold.getAttribute("aria-expanded") !== "true") await fold.click()
    await expect(fold).toHaveAttribute("aria-expanded", "true")
    await fold.click()
    await expect(fold).toHaveAttribute("aria-expanded", "false")
    await (await expectRailRowVisible({ page, sessionId: otherId })).click()
    await expectAssistantReplyVisible(page, "Other completed reply", { spec: "core-harness-rendering-matrix", scenario: `fold-other-${testInfo.repeatEachIndex}` })
    // The settled turn's frames land on the workspace stream while another
    // session is on screen — as a retained replay after a reconnect would —
    // and the stream is workspace-wide, so this reader receives them.
    const delivered = page.waitForResponse(async response => new URL(response.url()).pathname.endsWith("/api/wr/events") && response.status() === 200 && (await response.text()).includes(fixture.events[0].assistantMessageId!))
    for (const event of fixture.events) mock.emitRuntime({ ...event, directory: dir })
    await delivered
    const row = await expectRailRowVisible({ page, sessionId })
    const samples = await sampleElementDuringAction(page, '[data-component="tool-part-wrapper"]', async () => {
      await row.click()
      await expectAssistantReplyVisible(page, "QA_FIRST_DONE_1164", { spec: "core-harness-rendering-matrix", scenario: `fold-return-${testInfo.repeatEachIndex}` })
    })
    await writeFile(testInfo.outputPath("fold-return-frames.json"), JSON.stringify(samples, null, 2))
    expect(mock.requests.unhandled).toEqual([])
    expect(samples.length).toBeGreaterThan(2)
    expect(samples.filter(sample => sample.elements.some(element => element.painted)), "closed completed work exposes tool rows when its frames arrive late").toEqual([])
    await expect(fold).toHaveAttribute("aria-expanded", "false")
  })

  test("restored Codex failure commentary renders each reply passage once", async ({ page }, testInfo) => {
    const messages = JSON.parse(readFileSync(join(FIXTURES_DIR, "codex-interleaved-failures.json"), "utf-8")) as MockMessageRow[]
    const sessionId = messages[0].info.sessionID
    const dir = "/tmp/e2e-codex-interleaved-failures"
    const mock = await installMockRuntime(page, {
      dir, sessionId, projectId: PROJECT_ID, workspaceId: PROJECT_ID,
      harness: "codex-app-server", existingSession: { messages },
    })
    await seedOneProject(page, dir)
    await page.goto(`/${slug(dir)}/session/${sessionId}`)
    await ensureComposerModelSelected(page)
    await page.getByRole("textbox", { name: /Ask anything/i }).last().fill("Snapshot restoration probe")
    await page.locator(SELECTORS.submitControl).last().click()
    await expectAssistantReplyVisible(page, "ack 1: Snapshot restoration probe")
    for (const phase of ["restored", "reloaded"]) {
      if (phase === "reloaded") await page.reload()
      const fold = page.locator(`[data-message-id="${messages[0].info.id}"][data-timeline-row="TurnFold"] button`)
      await expect(fold).toBeVisible()
      if (await fold.getAttribute("aria-expanded") !== "true") await fold.click()
      await scrollTimelineToTop(page)
      for (const [index, text] of [
        "Running the first command exactly and recording its exit code.",
        "The first command exited with code 1. Running the separate grep command now.",
        "false: exit code 1",
        "grep QA_IMPOSSIBLE_MARKER_985312 package.json: exit code 1",
      ].entries()) {
        await expectAssistantReplyVisible(page, text, {
          spec: "core-harness-rendering-matrix",
          scenario: `restored-failure-${phase}-${index}-${testInfo.repeatEachIndex}`,
        })
        await expectAssistantTextOccurrences(page, text, 1)
      }
      await page.screenshot({ path: testInfo.outputPath(`${phase}-commentary.png`) })
    }
    expect(mock.requests.promptCount).toBe(1)
  })

  test("a consecutive MCP group names the tools hidden inside it", async ({ page }, testInfo) => {
    const { mock, dir, sessionId, assistantId, assistantInfo } = await primeHarness(page, "codex-app-server")
    for (const [index, name] of ["sessions_list", "processes"].entries()) {
      mock.emit({ type: "message.part.updated", properties: { part: {
        id: `mcp_count_${index}`, sessionID: sessionId, messageID: assistantId, type: "tool", callID: `mcp_count_${index}`, tool: name,
        state: { status: "completed", input: {}, output: "[]", title: name, metadata: { intent: "mcp", kind: "mcp_tool_call", server: "claxedo" }, time: { start: Date.now() - 1000, end: Date.now() } },
      } } } as never, dir)
    }
    mock.emit({ type: "message.updated", properties: { sessionID: sessionId, info: assistantInfo } } as never, dir)
    await expectAssistantReplyVisible(page, "ack 1: matrix probe codex-app-server")
    const group = page.locator('[data-timeline-part-ids="mcp_count_0,mcp_count_1"]')
    await expect(group).toBeVisible()
    const header = group.locator('[data-component="work-group-trigger"]')
    await expect(header).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath("mcp-group-header.png") })
    await expect.soft(header).toContainText(/sessions[_ ]list/i)
    await expect.soft(header).toContainText(/processes/i)
    await header.click()
    await expect(group.locator(SELECTORS.toolPart("mcp_count_0"))).toBeVisible()
    await expect(group.locator(SELECTORS.toolPart("mcp_count_1"))).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath("mcp-group-expanded.png") })
  })

  test("a running turn shows every row and no fold control; it folds once the turn completes", async ({ page }, testInfo) => {
    const { mock, dir, sessionId, assistantId, assistantInfo } = await primeHarness(page, "codex-app-server")
    // The primed assistant message is already completed, so this is a turn between
    // steps: settled by its message, still running by the session.
    mock.emit({ type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } } as never, dir)
    const entries = [
      { id: "count1_read", tool: "read", input: { filePath: "a.ts" } },
      { id: "count2_read", tool: "read", input: { filePath: "b.ts" } },
      { id: "count3_bash", tool: "bash", input: { command: "echo hi" } },
      { id: "count4_read", tool: "read", input: { filePath: "c.ts" } },
    ]
    for (const item of entries) mock.emit({ type: "message.part.updated", properties: { part: {
      id: item.id, tool: item.tool, sessionID: sessionId, messageID: assistantId, type: "tool", callID: item.id,
      state: { status: "completed", input: item.input, output: "hi", title: item.tool, metadata: {}, time: { start: Date.now() - 1000, end: Date.now() } },
    } } } as never, dir)
    const fold = page.locator('[data-component="turn-fold"] button')
    const groups = [
      page.locator('[data-timeline-part-ids="count1_read,count2_read"]'),
      page.locator('[data-timeline-part-id="count3_bash"]'),
      page.locator('[data-timeline-part-ids="count4_read"]'),
    ]
    for (const group of groups) await expect(group).toHaveCount(1)
    await expect(page.locator(SELECTORS.submitControl).last()).toHaveAttribute("data-icon", "stop")
    await expect(fold).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath("running-three-groups-unfolded.png") })
    mock.emit({ type: "message.updated", properties: { sessionID: sessionId, info: assistantInfo } } as never, dir)
    mock.emit({ type: "session.status", properties: { sessionID: sessionId, status: { type: "idle" } } } as never, dir)
    await expect(fold).toHaveAttribute("aria-expanded", "false")
    await expect(fold).toContainText("Worked")
    for (const group of groups) await expect(group).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath("completed-three-group-fold.png") })
    await fold.click()
    await expect(fold).toHaveAttribute("aria-expanded", "true")
    for (const group of groups) await expect(group).toHaveCount(1)
    await fold.click()
    await expect(fold).toHaveAttribute("aria-expanded", "false")
    for (const group of groups) await expect(group).toHaveCount(0)
  })

  test("process inspection output does not turn an MCP endpoint into a Local preview", async ({ page }, testInfo) => {
    const { mock, dir, sessionId, assistantId, assistantInfo } = await primeHarness(page, "codex-app-server")
    const cases = [
      { id: "tool_process_inspection", command: "ps -axo pid=,ppid=,comm=,args=", output: JSON.stringify({ url: "http://127.0.0.1:2593/api/claxedo/mcp?session=qa", headers: { Authorization: "Bearer REDACTED" } }), preview: undefined },
      { id: "tool_development_server", command: "bun run dev", output: "Local: http://127.0.0.1:8766/", preview: "http://127.0.0.1:8766/" },
    ]
    for (const item of cases) {
      mock.emit({ type: "message.part.updated", properties: { part: {
        id: item.id, sessionID: sessionId, messageID: assistantId, type: "tool", callID: item.id, tool: "bash",
        state: { status: "completed", input: { command: item.command }, output: item.output, title: "bash", metadata: { exitCode: 0 }, time: { start: Date.now() - 1000, end: Date.now() } },
      } } } as never, dir)
    }
    mock.emit({ type: "message.updated", properties: { sessionID: sessionId, info: assistantInfo } } as never, dir)
    await expectAssistantReplyVisible(page, "ack 1: matrix probe codex-app-server")
    await revealTurn(page)
    await page.screenshot({ path: testInfo.outputPath("local-preview-targets.png") })
    for (const item of cases) {
      const part = page.locator(SELECTORS.toolPart(item.id))
      await expect(part).toBeVisible()
      const preview = part.locator('[data-component="local-preview-row"]')
      if (item.preview) await expect(preview).toHaveAttribute("href", item.preview)
      else await expect.soft(preview, "an MCP control endpoint is not a development server").toHaveCount(0)
    }
  })

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

  test("a live command group shimmers between calls and settles when the reply passes it", async ({ page }) => {
    const dir = "/tmp/e2e-command-group-live"
    const sessionId = "ses_command_group_live"
    const userId = "msg_command_group_live"
    const assistantId = `${userId}_r`
    const created = Date.now() - 1_000
    const messages = [
      { info: { id: userId, sessionID: sessionId, role: "user", time: { created }, agent: "build", model: { providerID: "openai", modelID: "gpt-5" } },
        parts: [{ id: "prompt", sessionID: sessionId, messageID: userId, type: "text", text: "Run commands" }] },
      { info: { id: assistantId, sessionID: sessionId, role: "assistant", parentID: userId, time: { created: created + 1 },
          modelID: "gpt-5", providerID: "openai", mode: "auto", agent: "build", path: { cwd: dir, root: dir }, cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
        parts: [{ id: "a_text", sessionID: sessionId, messageID: assistantId, type: "text", text: "QA_COMMAND_GROUP_START" }] },
    ] as unknown as MockMessageRow[]
    const mock = await installMockRuntime(page, { dir, sessionId, projectId: PROJECT_ID, workspaceId: PROJECT_ID, harness: "opencode", existingSession: { messages } })
    await seedOneProject(page, dir)
    await page.goto(`/${slug(dir)}/session/${sessionId}`)
    await expect(page.getByText("QA_COMMAND_GROUP_START", { exact: true })).toBeVisible()
    mock.emit({ type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } } as never, dir)
    const emitCommand = (id: string, status: "running" | "completed") => mock.emit({
      type: "message.part.updated",
      properties: { sessionID: sessionId, time: Date.now(), part: {
        id, sessionID: sessionId, messageID: assistantId, type: "tool", callID: id, tool: "bash",
        state: status === "running"
          ? { status, input: { command: "pwd" }, time: { start: 100 } }
          : { status, input: { command: "pwd" }, output: "/repo", title: "pwd", metadata: {}, time: { start: 100, end: 110 } },
      } },
    } as never, dir)
    emitCommand("z_command_0", "completed")
    emitCommand("z_command_1", "running")
    const trigger = page.locator('[data-component="work-group-trigger"]').last()
    const shimmer = trigger.locator('[data-component="text-shimmer"]')
    await expect(shimmer).toHaveAttribute("aria-label", "Running pwd")
    await expect(shimmer).toHaveAttribute("data-active", "true")
    emitCommand("z_command_1", "completed")
    await trigger.click()
    const member = page.locator('[data-component="work-group-list"] [data-component="tool-part-wrapper"]').last()
    await expect(member.locator('[data-slot="basic-tool-tool-title"] [data-component="text-shimmer"]')).toHaveAttribute("aria-label", "Ran")
    await expect(member.locator('.ui-basic-tool-tool-leading-icon')).toBeVisible()
    await expect(shimmer).toHaveAttribute("aria-label", "Running pwd")
    await expect(shimmer).toHaveAttribute("data-active", "true")
    mock.emit({ type: "message.part.updated", properties: { sessionID: sessionId, time: Date.now(), part: {
      id: "zz_after_group", sessionID: sessionId, messageID: assistantId, type: "text", text: "QA_PASSED_COMMAND_GROUP", time: { start: 200 },
    } } } as never, dir)
    await expect(page.getByText("QA_PASSED_COMMAND_GROUP", { exact: true })).toBeVisible()
    await expect(shimmer).toHaveAttribute("aria-label", "Ran 2 commands")
    await expect(shimmer).toHaveAttribute("data-active", "false")
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

  test("Codex interrupted command remains terminal after message-page reload", async ({ page }, testInfo) => {
    const { mock, dir, sessionId, assistantId, assistantInfo } = await primeHarness(page, "codex-app-server")
    const captured = JSON.parse(readFileSync(join(FIXTURES_DIR, "codex-interrupted-command.json"), "utf8"))
    const part = { ...captured, sessionID: sessionId, messageID: assistantId }
    const row = page.locator(SELECTORS.toolPart(part.id))
    mock.emit({
      type: "message.part.updated",
      properties: { part: {
        ...part,
        state: { status: "running", input: part.state.input, metadata: part.state.metadata, time: { start: part.state.time.start } },
      } },
    } as never, dir)
    await expect(row).toBeVisible()
    await expect(row).toContainText("Running")
    await page.screenshot({ path: testInfo.outputPath("command-running.png") })
    mock.emit({ type: "message.part.updated", properties: { part } } as never, dir)
    mock.emit({ type: "message.updated", properties: { sessionID: sessionId, info: assistantInfo } } as never, dir)
    await expect(row).toContainText(/Failed|Interrupted/)
    await page.reload()
    await expectAssistantReplyVisible(page, "ack 1: matrix probe codex-app-server")
    await expect(row).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath("interrupted-command-reloaded.png") })
    await expect(row).toContainText(/Failed|Interrupted/)
    await expect(row).not.toContainText("Running")
  })

  test("an interrupted Codex command stays interrupted when rail-return replay resends its start", async ({ page }, testInfo) => {
    const dir = "/tmp/e2e-interrupted-replay"
    const sessionId = "ses_interrupted_replay"
    const otherId = "ses_interrupted_replay_other"
    const userId = "msg_interrupted_replay"
    const assistantId = `${userId}_r`
    const callId = "exec-interrupted-replay"
    const captured = JSON.parse(readFileSync(join(FIXTURES_DIR, "codex-interrupted-command.json"), "utf8"))
    // The stored part id is the runtime projection's `seqId` mint (`000000_<callID>`);
    // a projection restarted for the turn regenerates that id, which is how a
    // stale start frame reaches the already-settled part.
    const part = {
      ...captured,
      id: `000000_${callId}`,
      callID: callId,
      sessionID: sessionId,
      messageID: assistantId,
    }
    const messages = [
      {
        info: {
          id: userId, sessionID: sessionId, role: "user",
          time: { created: captured.state.time.start - 2000 },
          agent: "build", model: { providerID: "codex", modelID: "gpt-5.6-sol" },
        },
        parts: [{ id: `prt_${userId}`, sessionID: sessionId, messageID: userId, type: "text", text: "Run the bounded command" }],
      },
      {
        info: {
          id: assistantId, sessionID: sessionId, role: "assistant", parentID: userId,
          time: { created: captured.state.time.start - 1000, completed: captured.state.time.end },
          modelID: "gpt-5.6-sol", providerID: "codex", mode: "auto", agent: "build",
          path: { cwd: dir, root: dir }, cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [part],
      },
    ] as unknown as MockMessageRow[]
    const scenario = subagentScenario(subagentHarnessCases.find(item => item.name === "Codex native")!)
    const task = subagentTaskEnvelope({ sessionId, assistantId, toolCallId: scenario.toolCallId, description: scenario.description })
    messages[1]!.parts.push(task.payload.properties.part as never)
    const mock = await installMockRuntime(page, {
      dir, sessionId, projectId: PROJECT_ID, workspaceId: PROJECT_ID, harness: "codex-app-server",
      existingSession: { messages },
      subagents: { [sessionId]: scenario.fixture.rows },
      otherSessions: [{ id: otherId, title: "Other session", prompt: "Other prompt", reply: "Other reply" }],
    })
    await seedOneProject(page, dir)
    await page.goto(`/${slug(dir)}/session/${sessionId}`)
    const row = page.locator(SELECTORS.toolPart(part.id))
    await expect(row).toBeVisible()
    await expect(row).toContainText(/Failed|Interrupted/)
    await page.screenshot({ path: testInfo.outputPath("interrupted-before-replay.png") })
    await (await expectRailRowVisible({ page, sessionId: otherId })).click()
    await expectAssistantReplyVisible(page, "Other reply", { spec: "core-harness-rendering-matrix", scenario: `interrupt-away-${testInfo.repeatEachIndex}` })
    await (await expectRailRowVisible({ page, sessionId })).click()
    // Reload first: the canonical refetch must finish before the replay lands,
    // or the arriving messages overwrite the stale frame back to terminal and
    // mask the defect — the original report showed Running AFTER the reload.
    const refetched = page.waitForResponse(response =>
      response.request().method() === "GET"
      && /\/session\/[^/]+\/message/.test(new URL(response.url()).pathname)
      && response.status() === 200)
    await page.reload()
    await refetched
    await expect(row).toBeVisible()
    await expect(row).toContainText(/Failed|Interrupted/)
    // A projection restarted for the turn re-emits its start frames: the
    // terminal state is what the stored part already carries, and the fresh
    // projection has no memory of it.
    for (const payload of [
      {
        harness: "codex", threadId: sessionId, type: "tool-start",
        toolCallId: callId, toolName: "command", kind: "command_execution",
        display: { kind: "command_execution", intent: "shell", command: captured.state.input.command, description: captured.state.input.command },
      },
      { harness: "codex", threadId: sessionId, type: "tool-input", toolCallId: callId, input: captured.state.input },
    ]) {
      mock.emitRuntime({ directory: dir, sessionId, agentSessionId: sessionId, assistantMessageId: assistantId, payload: payload as never })
    }
    // Child status rides the same stream and acknowledges the preceding frames.
    completeSubagent(mock, dir, sessionId, scenario.subagentKey)
    await expect(page.locator(`[data-component="subagent-chip"][data-subagent-key="${scenario.subagentKey}"]`)).toHaveAttribute("data-status", "completed")
    await page.screenshot({ path: testInfo.outputPath("interrupted-after-replay.png") })
    const sawRunning = await expect
      .poll(async () => (await row.textContent())?.includes("Running"), { timeout: 5_000 })
      .toBe(true)
      .then(() => true)
      .catch(() => false)
    expect(sawRunning, "the stored interrupted command returned to Running after its start frames replayed").toBe(false)
  })

  test("a live reply's stored parts carry the runtime's projected ids, so its frames land on them instead of duplicating", async ({ page }) => {
    const dir = "/tmp/e2e-dup-replay"
    const sessionId = "ses_dup_replay"
    const otherId = "ses_dup_replay_other"
    const userId = "msg_dup_replay"
    const assistantId = `${userId}_r`
    const text = "QA_LIVE_REPLAY the two-item exit list renders once"
    const scenario = subagentScenario(subagentHarnessCases.find(item => item.name === "Codex native")!)
    // The runtime persists the parts its own projection minted: the first text
    // part of a turn is `000000_<msg>-text`, the tool call that follows it
    // `000001_<callID>`. A projection restarted for the same turn (a resumed
    // harness replays its events) regenerates those ids, so its frames must
    // reach the stored parts rather than sit beside them.
    const textPartId = `000000_${assistantId}-text`
    const taskPartId = `000001_${scenario.toolCallId}`
    const messages = [
      {
        info: {
          id: userId, sessionID: sessionId, role: "user",
          time: { created: Date.now() - 10_000 },
          agent: "build", model: { providerID: "codex", modelID: "gpt-5.6-sol" },
        },
        parts: [{ id: `prt_${userId}`, sessionID: sessionId, messageID: userId, type: "text", text: "Show the exit list" }],
      },
      {
        info: {
          id: assistantId, sessionID: sessionId, role: "assistant", parentID: userId,
          time: { created: Date.now() - 9_000 },
          modelID: "gpt-5.6-sol", providerID: "codex", mode: "auto", agent: "build",
          path: { cwd: dir, root: dir }, cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [{ id: textPartId, sessionID: sessionId, messageID: assistantId, type: "text", text }],
      },
    ] as unknown as MockMessageRow[]
    const task = subagentTaskEnvelope({ sessionId, assistantId, toolCallId: scenario.toolCallId, description: scenario.description, partId: taskPartId })
    messages[1]!.parts.push(task.payload.properties.part as never)
    const mock = await installMockRuntime(page, {
      dir, sessionId, projectId: PROJECT_ID, workspaceId: PROJECT_ID, harness: "codex-app-server",
      existingSession: { messages },
      subagents: { [sessionId]: scenario.fixture.rows },
      otherSessions: [{ id: otherId, title: "Other session", prompt: "Other prompt", reply: "Other reply" }],
    })
    await seedOneProject(page, dir)
    await page.goto(`/${slug(dir)}/session/${sessionId}`)
    const textRows = page.locator('[data-component="text-part"]').filter({ hasText: text })
    await expect(textRows).toHaveCount(1)
    await (await expectRailRowVisible({ page, sessionId: otherId })).click()
    await expectAssistantReplyVisible(page, "Other reply")
    await (await expectRailRowVisible({ page, sessionId })).click()
    await expect(page).toHaveURL(sessionUrlPattern(sessionId))
    await expect(textRows).toHaveCount(1)
    mock.emit({ type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } } as never, dir)
    for (const delta of ["QA_LIVE_REPLAY the two-item ", "exit list renders once"]) {
      mock.emitRuntime({ directory: dir, sessionId, agentSessionId: sessionId, assistantMessageId: assistantId, payload: { harness: "codex", threadId: sessionId, type: "text-delta", delta } as never })
    }
    const chip = page.locator(`[data-component="subagent-chip"][data-subagent-key="${scenario.subagentKey}"]`)
    await expect(chip).toHaveCount(1)
    mock.emitRuntime({ directory: dir, sessionId, assistantMessageId: assistantId, payload: { type: "tool-start", toolCallId: scenario.toolCallId, toolName: "task" } })
    // The child completion rides the same stream after the restart's frames,
    // so its visible status is the acknowledgement that they arrived.
    completeSubagent(mock, dir, sessionId, scenario.subagentKey)
    await expect(chip).toHaveCount(1)
    await expect(chip).toHaveAttribute("data-status", "completed")
    await expect(textRows).toHaveCount(1)
    await expect(page.locator(`[data-timeline-part-id="${textPartId}"]`)).toHaveCount(1)
    mock.emit({ type: "message.part.delta", properties: { sessionID: sessionId, messageID: assistantId, partID: textPartId, field: "text", delta: " Canonical continuation." } } as never, dir)
    await expect(textRows).toContainText(`${text} Canonical continuation.`)
    await expect(textRows).toHaveCount(1)
  })

  test("a settled reply does not re-render its streamed text when the turn's deltas replay", async ({ page }, testInfo) => {
    const dir = "/tmp/e2e-dup-replay"
    const sessionId = "ses_dup_replay"
    const otherId = "ses_dup_replay_other"
    const userId = "msg_dup_replay"
    const assistantId = `${userId}_r`
    const text = "QA_DUP_REPLAY the two-item exit list renders once"
    // The stored part carries an id (`prt_…`) no projection mints, so a
    // re-emitted delta cannot find it and the fresh `000000_<msg>-text` part
    // would be appended as a SECOND copy.
    const messages = [
      {
        info: {
          id: userId, sessionID: sessionId, role: "user",
          time: { created: Date.now() - 10_000 },
          agent: "build", model: { providerID: "codex", modelID: "gpt-5.6-sol" },
        },
        parts: [{ id: `prt_${userId}`, sessionID: sessionId, messageID: userId, type: "text", text: "Show the exit list" }],
      },
      {
        info: {
          id: assistantId, sessionID: sessionId, role: "assistant", parentID: userId,
          time: { created: Date.now() - 9_000, completed: Date.now() - 8_000 },
          modelID: "gpt-5.6-sol", providerID: "codex", mode: "auto", agent: "build",
          path: { cwd: dir, root: dir }, cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [{ id: "prt_dup_stored", sessionID: sessionId, messageID: assistantId, type: "text", text }],
      },
    ] as unknown as MockMessageRow[]
    const mock = await installMockRuntime(page, {
      dir, sessionId, projectId: PROJECT_ID, workspaceId: PROJECT_ID, harness: "codex-app-server",
      existingSession: { messages },
      otherSessions: [{ id: otherId, title: "Other session", prompt: "Other prompt", reply: "Other reply" }],
    })
    await seedOneProject(page, dir)
    await page.goto(`/${slug(dir)}/session/${sessionId}`)
    await expectAssistantReplyVisible(page, text, { spec: "core-harness-rendering-matrix", scenario: `dup-before-${testInfo.repeatEachIndex}` })
    await (await expectRailRowVisible({ page, sessionId: otherId })).click()
    await expectAssistantReplyVisible(page, "Other reply", { spec: "core-harness-rendering-matrix", scenario: `dup-away-${testInfo.repeatEachIndex}` })
    await (await expectRailRowVisible({ page, sessionId })).click()
    // A projection restarted for the finished turn re-emits its deltas while
    // the canonical messages fetch is still in flight: each frame is fresh
    // state — the first announces message.updated (dropping time.completed off
    // the stored envelope) and mints a fresh text part (`000000_<msg>-text`)
    // that the REST merge then keeps alongside the stored part (`prt_…`).
    // Emitting before reload lands the frames in the stream log; the delayed
    // fetch keeps the store empty while the reopened stream drains them.
    await page.route("**/session/*/message**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 800))
      await route.fallback()
    })
    for (const delta of ["QA_DUP_REPLAY the two-item ", "exit list renders once"]) {
      mock.emitRuntime({ directory: dir, sessionId, agentSessionId: sessionId, assistantMessageId: assistantId, payload: { harness: "codex", threadId: sessionId, type: "text-delta", delta } as never })
    }
    const refetched = page.waitForResponse(response =>
      response.request().method() === "GET"
      && /\/session\/[^/]+\/message/.test(new URL(response.url()).pathname)
      && response.status() === 200)
    await page.reload()
    await refetched
    await expectAssistantReplyVisible(page, text, { spec: "core-harness-rendering-matrix", scenario: `dup-restored-${testInfo.repeatEachIndex}` })
    // The merge order may flip with the fetch landing mid-replay — sample the
    // count across a window rather than once at the end.
    let maxCopies = 0
    await expect
      .poll(async () => {
        const n = await page.getByText("QA_DUP_REPLAY", { exact: false }).count()
        maxCopies = Math.max(maxCopies, n)
        return n
      }, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1)
    await page.screenshot({ path: testInfo.outputPath("dup-after-replay.png") })
    expect(maxCopies, "the settled reply's streamed text rendered more than once after its deltas replayed").toBe(1)
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

    // The trace's three capitalised calls reach the real renderer and fold into one
    // context group like their lowercase peers: the projection canonicalises the name
    // at tool-start, and the grouping and the registry canonicalise again on read, so
    // this proves the observable outcome, not which layer produced it.
    await expect(content.locator('[data-component="context-tool-group-trigger"]')).toBeVisible({ timeout: 45_000 })

    // A folded turn renders no tool rows at all, so the absence below has to be read
    // off an unfolded one or it is measuring an empty container.
    await revealTurn(page)
    await expect(content.locator('[data-component="tool-part-wrapper"]')).toHaveCount(1)
    // The distinguishing assertion: an unregistered name falls through to GenericTool.
    // Its title is prose ("Called `Grep`") that a locale spells its own way and that
    // `ui.tool.grep` can itself produce, so the renderer's own marker is the only
    // honest way to say no generic row was built.
    await expect(content.locator('[data-component="generic-tool"]')).toHaveCount(0)

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

      const before = await chip.boundingBox()
      expect(before).not.toBeNull()
      expect(before!.width).toBeLessThanOrEqual(448)
      expect(before!.height).toBe(28)

      completeSubagent(primed.mock, primed.dir, primed.sessionId, scenario.subagentKey)
      await expect(chip).toHaveAttribute("data-status", "completed", { timeout: 20_000 })
      await expect(chip.locator('[data-slot="subagent-chip-status"]')).toHaveText("done")
      const after = await chip.boundingBox()
      expect(after).not.toBeNull()
      expect(after!.width).toBeLessThanOrEqual(448)
      expect(after!.height).toBe(before!.height)
      expect(await chip.evaluate(el => getComputedStyle(el).borderRadius)).toBe("9999px")

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

  test("subagents — an interrupted spawn wrapper preserves its admitted child chip through completion", async ({ page }) => {
    const input = subagentHarnessCases.find((item) => item.name === "Codex native")!
    const scenario = subagentScenario(input)
    const primed = await primeHarness(page, input.harness, scenario.fixture)
    const envelope = subagentTaskEnvelope({
      sessionId: primed.sessionId,
      assistantId: primed.assistantId,
      toolCallId: scenario.toolCallId,
      description: scenario.description,
    })
    await replay(primed.mock, primed.dir, [envelope], primed.assistantInfo)
    const { chip, openControl } = subagentChip(page, scenario.subagentKey)
    await expect(chip).toHaveAttribute("data-status", "running")
    await expect(chip).toHaveCount(1)
    const before = await chip.boundingBox()
    expect(before?.height).toBe(28)

    const part = envelope.payload.properties.part
    primed.mock.emit({
      type: "message.part.updated",
      properties: {
        sessionID: primed.sessionId,
        time: 3,
        part: {
          ...part,
          state: {
            status: "error",
            input: part.state.input,
            error: "Tool execution interrupted",
            metadata: {},
            time: { start: 1, end: 3 },
          },
        },
      },
    } as never, primed.dir)
    completeSubagent(primed.mock, primed.dir, primed.sessionId, scenario.subagentKey)
    await expect(chip).toHaveAttribute("data-status", "completed")
    await expect(chip).toHaveCount(1)
    await expect(chip.locator('[data-slot="subagent-chip-status"]')).toHaveText("done")
    expect((await chip.boundingBox())?.height).toBe(before?.height)
    expect(await chip.evaluate(el => getComputedStyle(el).borderRadius)).toBe("9999px")
    await openControl.click()
    await expect(subagentTab(page, scenario.childSessionId!)).toBeVisible()
    await expect(workspacePanelBody(page).getByText(`child transcript for ${input.name}`, { exact: true })).toBeVisible()
  })

  test("subagents — below the md boundary the child opens read-only and returns to its parent", async ({ page }) => {
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

    // The committed narrow-screen policy gives the child the pane rather than
    // covering the parent with the desktop panel. Exercise its return path too.
    await expect(page.getByText(`child transcript for ${input.name}`, { exact: true })).toBeVisible()
    await expect(page.getByText("Subagent sessions cannot be prompted.", { exact: true })).toBeVisible()
    await expect(page.locator(`${SELECTORS.submitControl}:visible`)).toHaveCount(0)
    await expect(page.getByRole("textbox", { name: /Ask anything/i })).toHaveCount(0)
    await page.getByRole("button", { name: "Back to main session.", exact: true }).click()
    await expect(chip).toBeVisible()
    await expectAssistantReplyVisible(page, `ack 1: matrix probe ${input.harness}`)
  })

  test("subagents — bare Pi capability emits no subagent chip row", async ({ page }) => {
    const { mock } = await primeHarness(page, "pi")
    await expect(page.locator('[data-component="subagent-chip-row"]')).toHaveCount(0)
    expect(mock.requests.badResponses).toEqual([])
  })

  test("subagents — a session the authority does not grant is refused its scoped stream", async ({ page }) => {
    await primeHarness(page, "opencode", {
      rows: [],
      workspaceStreamAuthorize: ({ sessionID }) => sessionID !== "parent-denied",
    })
    const response = await page.evaluate(async () => {
      const result = await fetch("/api/wr/events?sessionID=parent-denied")
      return { status: result.status, body: await result.json() }
    })
    // The mock speaks the runtime's session-arm refusal, named apart from
    // the unscoped arm's `workspace_event_stream_denied`. This proves the
    // mock's body only; that the reader parks on it is
    // `claxedo-events-cursor.vitest.tsx`.
    expect(response).toEqual({ status: 403, body: { error: { code: "session_event_stream_denied", message: "Forbidden", cause: "session_private" } } })
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
