import fs from "node:fs"
import path from "node:path"
import type { Locator, Page } from "@playwright/test"
import type { CaseInteraction, CaseTurn, CorpusCase } from "../corpus/case"
import { expectDetachedGrowthAtMost, expectHeapGrowthAtMost, expectRowsKept, markDetachedNodes, markRows, quietDom, releaseHold, startLiveTurn } from "../corpus/live"
import { switchSessions } from "../corpus/switch"
import { playChildMessageEvent } from "../harness/child-message-event"
import { playAgentAuthoredMessage } from "../harness/agent-authored-message"
import { playHostChildFollowup } from "../harness/host-child-followup"
import { expectWritesAtMost, watchWrites } from "../corpus/writes"
import { readerRow } from "../harness/session-reader"
import { registerTranscriptOutcomeTests } from "./30-transcript-outcomes"
import { acpScriptToken, expect, SCRIPTED_ACP_HARNESS, sessionRoute, test, type AcpStep, type ClaxedoApi, type MessageRow, type Stack } from "../harness"

const CASES_DIR = path.join(import.meta.dirname, "..", "corpus", "cases")
const LIVE_DURATIONS_STYLE = path.join(import.meta.dirname, "..", "corpus", "live-durations.css")
const TURN_TIMEOUT = 30_000
const TALL_VIEWPORT = 1600
const CLOCK_TIME = /\b\d{1,2}:\d{2}\s?(?:AM|PM)\b/g
const UUID = /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/g
const LIVE_DURATION = /(· |Worked for )\d+(?:h \d+m|m \d+s|ms|s|m|h)\b/g
const HELD_IMAGE = "/held-image.png"

type Target = { readonly directory: string; readonly sessionId: string }

function loadCases(): CorpusCase[] {
  return fs
    .readdirSync(CASES_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => JSON.parse(fs.readFileSync(path.join(CASES_DIR, file), "utf8")) as CorpusCase)
}

function inWorkspace<T>(value: T, directory: string, heldImage: string): T {
  return JSON.parse(JSON.stringify(value).replaceAll("{{workspace}}", directory).replaceAll("{{heldImage}}", heldImage)) as T
}

function turnSettled(messages: readonly MessageRow[], users: number): boolean {
  const userCount = messages.filter((message) => message.info.role === "user").length
  const last = messages.at(-1)?.info
  if (userCount < users || last?.role !== "assistant") return false
  const time = last.time as { completed?: number } | undefined
  return time?.completed !== undefined || last.error !== undefined
}

function playedUpToHold(messages: readonly MessageRow[], steps: readonly AcpStep[], users: number): boolean {
  if (messages.filter((message) => message.info.role === "user").length < users) return false
  const last = messages.at(-1)
  if (last?.info.role !== "assistant") return false
  const tools = last.parts.filter((part) => part.type === "tool" && (part.state as { status?: string } | undefined)?.status === "completed")
  const texts = last.parts.filter((part) => part.type === "text")
  return tools.length >= steps.filter((step) => step.kind === "tool").length && texts.length >= steps.filter((step) => step.kind === "text").length
}

async function playTurn(stack: Stack, api: ClaxedoApi, target: Target, turn: CaseTurn & { readonly name: string }, users: number) {
  await stack.acp.write(turn.name, { steps: [...turn.steps] })
  const text = `${turn.prompt} ${acpScriptToken(turn.name)}`
  if (!turn.abort && !turn.steps.some((step) => step.kind === "error")) {
    await api.prompt(target.directory, target.sessionId, text)
    return
  }
  await api.promptAsync(target.directory, target.sessionId, text)
  if (turn.abort) {
    await expect
      .poll(async () => playedUpToHold(await api.messages(target.directory, target.sessionId), turn.steps, users), { timeout: TURN_TIMEOUT })
      .toBe(true)
    await api.stopTurn(target.directory, target.sessionId)
  }
  await expect
    .poll(async () => turnSettled(await api.messages(target.directory, target.sessionId), users), { timeout: TURN_TIMEOUT })
    .toBe(true)
}

async function arrange(stack: Stack, api: ClaxedoApi, corpusCase: CorpusCase) {
  if (corpusCase.replay.agent === "claude") {
    if (corpusCase.replay.scenario === "host-child-followup") return playHostChildFollowup(stack, api)
    return corpusCase.replay.scenario === "agent-authored-message"
      ? playAgentAuthoredMessage(stack, api)
      : playChildMessageEvent(stack, api)
  }
  if (corpusCase.replay.agent !== "acp") throw new Error(`${corpusCase.id} has no scripted replay`)
  const workspace = await stack.daemon.makeWorkspace("corpus")
  const session = await api.createSession(workspace.directory, { title: corpusCase.title, harness: SCRIPTED_ACP_HARNESS })
  const target = { directory: workspace.directory, sessionId: session.id }
  const holdsImage = JSON.stringify(corpusCase.replay.turns).includes("{{heldImage}}")
  const heldImage = holdsImage ? `${(await stack.localPages({}, { held: [HELD_IMAGE], secure: true })).url}${HELD_IMAGE}` : ""
  const turns = inWorkspace(corpusCase.replay.turns, workspace.directory, heldImage).map((turn, index) => ({ ...turn, name: `${corpusCase.id}-${index}` }))
  for (const [index, turn] of turns.entries()) {
    if (!turn.live) await playTurn(stack, api, target, turn, index + 1)
  }
  return { workspace, target, turns: turns.length, live: turns.filter((turn) => turn.live) }
}

function sessionUrl(stack: Stack, workspaceId: string, sessionId: string): string {
  return `${stack.url}${sessionRoute(workspaceId, sessionId)}`
}

function turnRows(app: Page): Locator {
  return app.locator('[data-component="session-turn"]:not([inert] *, [aria-hidden="true"] *)')
}

function scroller(app: Page): Locator {
  return app.getByRole("region", { name: "scrollable content" })
}

type RowsBox = { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

async function shownRows(app: Page): Promise<boolean[]> {
  return turnRows(app).evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height > 0))
}

async function rowsBox(app: Page): Promise<RowsBox | undefined> {
  return turnRows(app).evaluateAll((rows) => {
    const boxes = rows.map((row) => row.getBoundingClientRect()).filter((box) => box.height > 0)
    if (boxes.length === 0) return undefined
    const top = Math.min(...boxes.map((box) => box.top))
    const left = Math.min(...boxes.map((box) => box.left))
    const bottom = Math.max(...boxes.map((box) => box.bottom))
    const right = Math.max(...boxes.map((box) => box.right))
    return { x: Math.floor(left), y: Math.floor(top), width: Math.ceil(right - left), height: Math.ceil(bottom - top) }
  })
}

function backgroundSubagents(app: Page): Locator {
  return app.getByRole("region", { name: "Background subagents" })
}

async function withBackground(app: Page, rows: RowsBox | undefined): Promise<RowsBox | undefined> {
  const background = (await backgroundSubagents(app).count()) > 0 ? await backgroundSubagents(app).boundingBox() : null
  if (!rows || !background) return rows
  const top = Math.min(rows.y, Math.floor(background.y))
  const bottom = Math.max(rows.y + rows.height, Math.ceil(background.y + background.height))
  return { x: rows.x, y: top, width: rows.width, height: bottom - top }
}

function hasVariableDurations(corpusCase: CorpusCase): boolean {
  return corpusCase.replay.agent === "claude"
    || (corpusCase.replay.agent === "acp" && corpusCase.replay.turns.some((turn) => turn.live))
}

async function compareStage(app: Page, corpusCase: CorpusCase, baseline: string, stage: string) {
  await app.mouse.move(0, 0)
  await quietDom(app)
  const box = await withBackground(app, await rowsBox(app))
  expect(box, `${corpusCase.id} renders its turn rows at ${stage}`).toBeDefined()
  if (!box) return
  await expect.soft(app).toHaveScreenshot([baseline, `${stage}.png`], {
    clip: box,
    animations: "disabled",
    caret: "hide",
    mask: [app.locator('[data-component="agent-glyph"]')],
    ...(hasVariableDurations(corpusCase) ? { stylePath: LIVE_DURATIONS_STYLE } : {}),
  })
  const shown = await shownRows(app)
  const trees: string[] = []
  for (const [index, visible] of shown.entries()) {
    trees.push(`row ${index}:\n${visible ? await turnRows(app).nth(index).ariaSnapshot() : "(empty)"}`)
  }
  const top = await scroller(app).first().evaluate((element) => Math.round(element.scrollTop))
  const background = (await backgroundSubagents(app).count()) > 0 ? await backgroundSubagents(app).ariaSnapshot() : "(none)"
  const stable = `scrollTop: ${top}\nbackground subagents:\n${background}\n${trees.join("\n")}\n`.replace(CLOCK_TIME, "<time>")
    .replace(UUID, "<id>")
  const tree = hasVariableDurations(corpusCase) ? stable.replace(LIVE_DURATION, "$1<duration>") : stable
  expect.soft(tree).toMatchSnapshot([baseline, `${stage}-tree.txt`])
}

async function interact(live: { stack: Stack; api: ClaxedoApi; target: Target; app: Page }, corpusCase: CorpusCase, interaction: CaseInteraction) {
  const { stack, app } = live
  switch (interaction.kind) {
    case "release":
      await releaseHold(live, interaction)
      return
    case "markRows":
      await markRows(app)
      return
    case "rowsKept":
      await expectRowsKept(app)
      return
    case "markDetached":
      await markDetachedNodes(app)
      return
    case "detachedGrowth":
      await expectDetachedGrowthAtMost(app, interaction.max)
      return
    case "heapGrowth":
      await expectHeapGrowthAtMost(app, interaction.maxKb)
      return
    case "watchWrites":
      await watchWrites(app, interaction.scope)
      return
    case "writesAtMost":
      await expectWritesAtMost(app, interaction.max)
      return
    case "outcomeSeen":
      if (interaction.seen) await expect(app.getByText(interaction.result, { exact: true })).toBeInViewport()
      else await expect(app.getByText(interaction.result, { exact: true })).not.toBeInViewport()
      await expect.poll(async () => {
        const row = await readerRow(stack, live.target.sessionId)
        if (!row.attention.outcome) return "no outcome"
        return interaction.seen
          ? row.reader?.generation === row.attention.generation && row.reader.seenThrough === row.attention.outcome.sequence
          : (row.reader?.seenThrough ?? 0) < row.attention.outcome.sequence
      }, { message: "seen state acknowledges only the exact final outcome actually displayed in the transcript" }).toBe(true)
      return
    case "switchSessions":
      await switchSessions(live, { title: corpusCase.title, ready: corpusCase.ready, times: interaction.times })
      return
    case "scroll":
      if (typeof interaction.to !== "string") throw new Error("scrolling to a turn is not replayed yet")
      await scroller(app).evaluate((element, to) => element.scrollTo({ top: to === "top" ? 0 : element.scrollHeight }), interaction.to)
      return
    case "readerScroll":
      await scroller(app).hover()
      await app.mouse.wheel(0, interaction.to === "top" ? -100000 : 100000)
      await expect.poll(async () => scroller(app).evaluate((element, to) => to === "top" ? element.scrollTop : Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop), interaction.to)).toBeLessThanOrEqual(1)
      return
    case "toggleFold":
      await app.getByRole("button", { name: /^Worked/ }).nth(interaction.turn).click()
      return
    case "toggleUserMessage":
      await app.locator('[data-component="user-message"]').filter({ hasText: interaction.message }).getByRole("button", { name: /^Show (all|less)$/ }).click()
      return
    case "toggleAgentMessage":
      await app.locator('[data-component="agent-message-notice"] summary').click()
      return
    case "reload":
      await app.reload()
      return
    default:
      throw new Error(`interaction ${interaction.kind} is not replayed yet`)
  }
}

function requireBaseline(corpusCase: CorpusCase) {
  if (fs.existsSync(path.join(test.info().snapshotDir, corpusCase.id))) return
  if (test.info().config.updateSnapshots !== "none") return
  throw new Error(`Record the baseline first: bun run e2e -- ${path.relative(process.cwd(), test.info().file)} --update-snapshots=all`)
}

for (const corpusCase of loadCases()) {
  test(`30 transcript corpus: ${corpusCase.id}`, async ({ stack, api, app }) => {
    requireBaseline(corpusCase)
    const baseline = corpusCase.id
    const { workspace, target, turns, live } = await arrange(stack, api, corpusCase)
    await app.setViewportSize({ width: app.viewportSize()?.width ?? 1280, height: TALL_VIEWPORT })
    await app.goto(sessionUrl(stack, workspace.id, target.sessionId))
    await expect(turnRows(app).first()).toBeVisible()
    for (const turn of live) await startLiveTurn(stack, api, target, turn)
    await expect(app.getByText(corpusCase.ready).first()).toBeVisible()
    await compareStage(app, corpusCase, baseline, "open")
    for (const [index, interaction] of corpusCase.interactions.entries()) {
      await interact({ stack, api, target, app }, corpusCase, interaction)
      await expect(app.getByText(corpusCase.ready).first()).toBeAttached()
      await compareStage(app, corpusCase, baseline, `${index + 1}-${interaction.kind}`)
    }
    const messages = await api.messages(target.directory, target.sessionId)
    expect(messages.filter((message) => message.info.role === "user")).toHaveLength(turns)
  })
}

registerTranscriptOutcomeTests()
