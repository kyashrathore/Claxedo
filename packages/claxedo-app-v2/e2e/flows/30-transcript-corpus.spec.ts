import fs from "node:fs"
import path from "node:path"
import type { Locator, Page } from "@playwright/test"
import type { CaseInteraction, CaseTurn, CorpusCase } from "../corpus/case"
import { acpScriptToken, expect, SCRIPTED_ACP_HARNESS, sessionRoute, test, type ClaxedoApi, type MessageRow, type Stack } from "../harness"

const CASES_DIR = path.join(import.meta.dirname, "..", "corpus", "cases")
const TURN_TIMEOUT = 30_000
const TALL_VIEWPORT = 1600
const LATEST_TURN_READ = /[?&]view=latest-turn\b/
const CLOCK_TIME = /\b\d{1,2}:\d{2}\s?(?:AM|PM)\b/g
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g

type Target = { readonly directory: string; readonly sessionId: string }

function loadCases(): CorpusCase[] {
  return fs
    .readdirSync(CASES_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => JSON.parse(fs.readFileSync(path.join(CASES_DIR, file), "utf8")) as CorpusCase)
}

function inWorkspace<T>(value: T, directory: string): T {
  return JSON.parse(JSON.stringify(value).replaceAll("{{workspace}}", directory)) as T
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

function ascendingMessageIds(): () => string {
  let counter = 0
  return () => {
    const ordered = (BigInt(Date.now()) * 4096n + BigInt(++counter)) & 0xffffffffffffn
    const random = Array.from(crypto.getRandomValues(new Uint8Array(14)), (byte) => BASE62[byte % 62]).join("")
    return `msg_${ordered.toString(16).padStart(12, "0")}${random}`
  }
}

function turnSettled(messages: readonly MessageRow[], users: number): boolean {
  const userCount = messages.filter((message) => message.info.role === "user").length
  const last = messages.at(-1)?.info
  if (userCount < users || last?.role !== "assistant") return false
  const time = last.time as { completed?: number } | undefined
  return time?.completed !== undefined || last.error !== undefined
}

async function playTurn(stack: Stack, api: ClaxedoApi, target: Target, turn: CaseTurn & { readonly name: string; readonly messageId: string }, users: number) {
  await stack.acp.write(turn.name, { steps: [...turn.steps] })
  const text = `${turn.prompt} ${acpScriptToken(turn.name)}`
  if (!turn.steps.some((step) => step.kind === "error")) {
    await api.prompt(target.directory, target.sessionId, text, { messageId: turn.messageId })
    return
  }
  await api.promptAsync(target.directory, target.sessionId, text, { messageId: turn.messageId })
  await expect
    .poll(async () => turnSettled(await api.messages(target.directory, target.sessionId), users), { timeout: TURN_TIMEOUT })
    .toBe(true)
}

async function arrange(stack: Stack, api: ClaxedoApi, corpusCase: CorpusCase) {
  if (corpusCase.replay.agent !== "acp") throw new Error(`${corpusCase.id} has no scripted replay`)
  const workspace = await stack.daemon.makeWorkspace("corpus")
  const session = await api.createSession(workspace.directory, { title: corpusCase.title, harness: SCRIPTED_ACP_HARNESS })
  const target = { directory: workspace.directory, sessionId: session.id }
  const turns = inWorkspace(corpusCase.replay.turns, workspace.directory)
  const nextId = ascendingMessageIds()
  for (const [index, turn] of turns.entries()) {
    await playTurn(stack, api, target, { ...turn, name: `${corpusCase.id}-${index}`, messageId: nextId() }, index + 1)
  }
  return { workspace, target, turns: turns.length }
}

function sessionUrl(stack: Stack, workspaceId: string, sessionId: string): string {
  return `${stack.url}${sessionRoute(workspaceId, sessionId)}`
}

function turnRows(app: Page): Locator {
  return app.locator('[data-component="session-turn"]')
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

async function compareStage(app: Page, corpusCase: CorpusCase, stage: string) {
  await app.mouse.move(0, 0)
  const box = await withBackground(app, await rowsBox(app))
  expect(box, `${corpusCase.id} renders its turn rows at ${stage}`).toBeDefined()
  if (!box) return
  await expect.soft(app).toHaveScreenshot([corpusCase.id, `${stage}.png`], {
    clip: box,
    animations: "disabled",
    caret: "hide",
    mask: [app.locator('[data-component="agent-glyph"]')],
  })
  const shown = await shownRows(app)
  const trees: string[] = []
  for (const [index, visible] of shown.entries()) {
    trees.push(`row ${index}:\n${visible ? await turnRows(app).nth(index).ariaSnapshot() : "(empty)"}`)
  }
  const top = await scroller(app).first().evaluate((element) => Math.round(element.scrollTop))
  const background = (await backgroundSubagents(app).count()) > 0 ? await backgroundSubagents(app).ariaSnapshot() : "(none)"
  const tree = `scrollTop: ${top}\nbackground subagents:\n${background}\n${trees.join("\n")}\n`.replace(CLOCK_TIME, "<time>")
    .replace(UUID, "<id>")
  expect.soft(tree).toMatchSnapshot([corpusCase.id, `${stage}-tree.txt`])
}

async function interact(app: Page, interaction: CaseInteraction) {
  switch (interaction.kind) {
    case "scroll":
      if (typeof interaction.to !== "string") throw new Error("scrolling to a turn is not replayed yet")
      await scroller(app).evaluate((element, to) => element.scrollTo({ top: to === "top" ? 0 : element.scrollHeight }), interaction.to)
      return
    case "toggleFold":
      await app.getByRole("button", { name: /^Worked/ }).nth(interaction.turn).click()
      return
    case "reload":
      await app.reload()
      return
    default:
      throw new Error(`interaction ${interaction.kind} is not replayed yet`)
  }
}

async function holdLatestTurnRead(app: Page) {
  let open!: () => void
  const opened = new Promise<void>((resolve) => (open = resolve))
  await app.route(LATEST_TURN_READ, async (route) => {
    await opened
    await route.continue()
  })
  return {
    release: async () => {
      const landed = app.waitForResponse(LATEST_TURN_READ)
      open()
      await landed
      await app.unroute(LATEST_TURN_READ)
    },
  }
}

function requireV1Baseline(stack: Stack, corpusCase: CorpusCase) {
  if (stack.app !== "v2") return
  const baseline = path.join(test.info().snapshotDir, corpusCase.id)
  if (!fs.existsSync(baseline)) throw new Error(`Record today's app first: bun run e2e -- --app=v1 ${path.relative(process.cwd(), test.info().file)} --update-snapshots=all`)
}

for (const corpusCase of loadCases()) {
  test(`30 transcript corpus: ${corpusCase.id}`, async ({ stack, api, app }) => {
    requireV1Baseline(stack, corpusCase)
    const { workspace, target, turns } = await arrange(stack, api, corpusCase)
    await app.setViewportSize({ width: app.viewportSize()?.width ?? 1280, height: TALL_VIEWPORT })
    const fullRead = await holdLatestTurnRead(app)
    await app.goto(sessionUrl(stack, workspace.id, target.sessionId))
    await expect(turnRows(app).first()).toBeVisible()
    await fullRead.release()
    await expect(app.getByText(corpusCase.ready).first()).toBeVisible()
    await compareStage(app, corpusCase, "open")
    for (const [index, interaction] of corpusCase.interactions.entries()) {
      await interact(app, interaction)
      await expect(app.getByText(corpusCase.ready).first()).toBeAttached()
      await compareStage(app, corpusCase, `${index + 1}-${interaction.kind}`)
    }
    const messages = await api.messages(target.directory, target.sessionId)
    expect(messages.filter((message) => message.info.role === "user")).toHaveLength(turns)
  })
}

test("30 an opened session shows its last turn's work folded under Worked, as today's app does", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("reopen")
  await stack.acp.write("work", {
    steps: [
      { kind: "reasoning", text: "Looking around the project" },
      { kind: "tool", tool: "read", title: "Read README.md", locations: [{ path: `${workspace.directory}/README.md` }], text: "reopen\n" },
      { kind: "tool", tool: "execute", title: "git status", input: { command: "git status" }, text: "nothing to commit" },
      { kind: "text", text: "All checked here." },
    ],
  })
  const session = await api.createSession(workspace.directory, { title: "Reopened work", harness: SCRIPTED_ACP_HARNESS })
  await api.prompt(workspace.directory, session.id, `Check the project. ${acpScriptToken("work")}`)

  await app.goto(sessionUrl(stack, workspace.id, session.id))
  await expect(app.getByText("All checked here.")).toBeVisible()
  const worked = app.getByRole("button", { name: /^Worked/ })
  await expect(worked).toBeVisible()
  await worked.click()
  await expect(app.getByText("git status").first()).toBeVisible()

  const messages = await api.messages(workspace.directory, session.id)
  expect(messages.flatMap((message) => message.parts).filter((part) => part.type === "tool")).toHaveLength(2)
})
