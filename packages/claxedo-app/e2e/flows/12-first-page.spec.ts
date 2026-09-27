import { writeFile } from "node:fs/promises"
import type { Page } from "@playwright/test"
import { acpScriptToken, expect, expectNothingAnimating, recordStillness, SCRIPTED_ACP_HARNESS, sessionRoute, sinceFirstReady, stillnessAfter, test, UI, type AcpStep, type ClaxedoApi, type Stack } from "../harness"
import { seedTurns } from "./12-switch-paint.seed"

test.skip(({ isMobile }) => isMobile, "flow 12 runs at desktop width; flow 33 covers the phone")

const IDLE_MS = 2_000

async function seedShellTurns(stack: Stack, api: ClaxedoApi, directory: string, title: string, turns: number, folds: boolean) {
  const session = await api.createSession(directory, { title, harness: SCRIPTED_ACP_HARNESS })
  const output = (turn: number) => Array.from({ length: 400 }, (_, line) => `${title} output ${turn}.${line + 1}`).join("\n")
  for (let turn = 1; turn <= turns; turn += 1) {
    const steps: AcpStep[] = [
      ...(folds ? [{ kind: "text", text: `Checking ${title} ${turn}.` } as const] : []),
      { kind: "tool", tool: "execute", title: `cat ${title}-${turn}.log`, input: { command: `cat ${title}-${turn}.log` }, text: output(turn) },
      { kind: "text", text: Array.from({ length: 6 }, (_, line) => `${title} reply ${turn}.${line + 1}.`).join("\n\n") },
    ]
    const script = `first-page-${title}-${turn}`
    await stack.acp.write(script, { steps })
    await api.prompt(directory, session.id, `${title} turn ${turn}: run it. ${acpScriptToken(script)}`)
  }
  return session
}

const now = (app: Page) => app.evaluate(() => performance.now())

const top = async (app: Page, text: string) => (await app.getByText(text, { exact: false }).first().boundingBox())?.y ?? Number.NaN

for (const fold of ["terminal", "headers"] as const) {
  test.describe(`fold=${fold}`, () => {
    test.use({ daemonEnv: { CLAXEDO_PERF_FOLD_READ: fold } })

    test(`12 a cold open reads nothing and moves nothing from its first page through ${IDLE_MS} ms of idle (fold=${fold})`, async ({ stack, api, app }) => {
      const workspace = await stack.daemon.makeWorkspace("still", "Still")
      const session = await seedShellTurns(stack, api, workspace.directory, "Still", 8, true)
      await recordStillness(app, { sessionId: session.id, marker: "Still reply 8.6." })
      await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
      await expect(app.getByText("Still reply 8.6.")).toBeVisible()
      const recorded = await stillnessAfter(app, IDLE_MS)
      await writeFile(test.info().outputPath("stillness.json"), JSON.stringify(recorded))
      const still = sinceFirstReady(recorded)
      expect(still.watchedMs).toBeGreaterThanOrEqual(IDLE_MS - 100)
      expect(recorded.reads.map((read) => read.kind), "the transcript reads of a cold open").toEqual(["first"])
      expect(still.scrolls, "scroll events on the transcript after its first paint").toBe(0)
      expect(still.scrollTopDelta, "scrollTop change after the first paint").toBe(0)
      expect(still.scrollHeightDelta, "scrollHeight change after the first paint").toBe(0)
      await expect(app.locator(`[data-session-id="${session.id}"][data-testid="session-page-root"]`)).not.toContainText("Still output 8.")
    })

    test(`12 opening a header row reads its whole part once, draws its body and moves nothing above it (fold=${fold})`, async ({ stack, api, app }) => {
      const workspace = await stack.daemon.makeWorkspace("open-row", "Open row")
      const session = await seedShellTurns(stack, api, workspace.directory, "Row", 6, false)
      await recordStillness(app, { sessionId: session.id, marker: "Row reply 6.6." })
      await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
      await expect(app.getByText("Row reply 6.6.")).toBeVisible()
      await expectNothingAnimating(app)
      const row = app.locator('[data-component="tool-part-wrapper"]').last()
      const collapsed = (await row.boundingBox())?.height
      const prompt = await top(app, "Row turn 6: run it.")
      const from = await now(app)
      await row.getByRole("button").first().click()
      await expect(row).toContainText("Row output 6.400")
      await expectNothingAnimating(app)
      expect(await top(app, "Row turn 6: run it."), "the prompt above the opened row").toBe(prompt)
      const reads = (await stillnessAfter(app, 0)).reads.filter((read) => read.at >= from).map((read) => read.kind)
      expect(reads, "reads the opened row made").toEqual(["part"])
      await row.getByRole("button").first().click()
      await expect(row).not.toContainText("Row output 6.400")
      await expectNothingAnimating(app)
      expect((await row.boundingBox())?.height, "the row closed again is as tall as its header was").toBe(collapsed)
    })

    test(`12 opening a folded turn draws its tool headers without their output and moves nothing above the fold (fold=${fold})`, async ({ stack, api, app }) => {
      const workspace = await stack.daemon.makeWorkspace("open-fold", "Open fold")
      const session = await seedTurns(stack, api, workspace.directory, "Fold", 6, { lines: 4 })
      await recordStillness(app, { sessionId: session.id, marker: "Fold reply line 6." })
      await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
      const button = app.getByRole("button", { name: UI.workedFor }).last()
      await expect(button).toBeVisible()
      await expectNothingAnimating(app)
      const prompt = await top(app, "Fold turn 6 line 1")
      const from = await now(app)
      await button.click()
      await expect(app.getByText("Explored", { exact: true }).last()).toBeVisible()
      await expectNothingAnimating(app)
      expect(await top(app, "Fold turn 6 line 1"), "the prompt above the opened fold").toBe(prompt)
      const reads = (await stillnessAfter(app, 0)).reads.filter((read) => read.at >= from).map((read) => read.kind)
      expect(reads, "reads the opened fold made").toEqual(fold === "terminal" ? ["turn"] : [])
    })
  })
}

test("12 a warm return to a session read open, with every fold, group and row opened and scrolled to its middle, paints as it was left and reads only its row", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("warm-open", "Warm open")
  const session = await seedShellTurns(stack, api, workspace.directory, "Warm", 4, true)
  await seedTurns(stack, api, workspace.directory, "Elsewhere", 1)
  await recordStillness(app, { sessionId: session.id, marker: "Warm reply 4.6." })
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await expect(app.getByText("Warm reply 4.6.")).toBeVisible()
  const timeline = app.locator(`[data-session-id="${session.id}"][data-testid="session-page-root"]`)
  const scroller = timeline.locator('[data-slot="session-timeline-scroll"] [data-scrollable]').first()
  await scroller.evaluate(async (element) => {
    element.scrollTo({ top: 0 })
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
  await expectNothingAnimating(app)
  const openShown = async (buttons: ReturnType<Page["getByRole"]>) => {
    const closed = buttons.and(app.locator('[aria-expanded="false"]'))
    while ((await closed.count()) > 0) {
      const landed = app.waitForResponse((response) => /\/session\/[^/]+\/(turn\?|message\/[^/]+\/part\/)/.test(response.url()))
      await closed.first().click()
      await landed
      await expectNothingAnimating(app)
    }
  }
  for (let atEnd = false; !atEnd; ) {
    await openShown(timeline.getByRole("button", { name: UI.workedFor }))
    await openShown(timeline.getByRole("button", { name: /^Ran cat Warm-/ }))
    atEnd = await scroller.evaluate(async (element) => {
      element.scrollBy({ top: element.clientHeight / 2 })
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      return element.scrollTop + element.clientHeight >= element.scrollHeight - 1
    })
    await expectNothingAnimating(app)
  }
  await openShown(timeline.getByRole("button", { name: UI.workedFor }))
  await openShown(timeline.getByRole("button", { name: /^Ran cat Warm-/ }))
  await expect(timeline).toContainText("Warm output 4.400")
  expect((await stillnessAfter(app, 0)).reads.filter((read) => read.kind === "part").length, "the rows' part reads").toBe(4)
  await expectNothingAnimating(app)
  await scroller.evaluate(async (element) => {
    element.scrollTo({ top: Math.round((element.scrollHeight - element.clientHeight) / 2) })
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
  await expectNothingAnimating(app)
  const left = await scroller.evaluate((element) => ({ scrollTop: element.scrollTop, opened: element.querySelectorAll('[aria-expanded="true"]').length }))
  expect(left.scrollTop).toBeGreaterThan(0)

  const rail = app.getByRole("navigation", { name: UI.rail })
  await rail.getByRole("button", { name: "Elsewhere", exact: true }).click()
  await expect(app.getByText("Elsewhere reply line 6.").first()).toBeVisible()
  const from = await now(app)
  await rail.getByRole("button", { name: "Warm", exact: true }).click()
  const still = sinceFirstReady(await stillnessAfter(app, IDLE_MS), from)
  expect(Math.abs(still.first.scrollTop - left.scrollTop), "scrollTop in the return's first frame against where the reader left it").toBeLessThanOrEqual(1)
  expect(still.first.opened, "opened folds, groups and rows in the return's first frame").toBe(left.opened)
  expect(still.readsSince.filter((kind) => kind !== "row"), "transcript reads of the return").toEqual([])
  expect(still.scrolls, "scroll events after the return's first frame").toBe(0)
  expect(still.scrollHeightDelta, "scrollHeight change after the return's first frame").toBe(0)
  expect(still.scrollTopDelta, "scrollTop change after the return's first frame").toBe(0)
})
