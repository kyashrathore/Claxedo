import { expect, test } from "@playwright/test"
import { installMockRuntime } from "../helpers/mock-runtime"
import { ensureComposerModelSelected, SELECTORS } from "../helpers/turn-oracle"

const DIR = "/tmp/e2e-queued-messages"
const SESSION = "ses_queued_messages"

test("@core queued messages sit in the timeline as dimmed bubbles with hover controls, edit-in-place and Escape to cancel", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 })
  const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION, projectId: "proj_mock_runtime", holdTurn: true,
    harnessModels: { opencode: [{ id: "gpt-5", name: "GPT-5" }] } })
  await page.addInitScript(({ dir }) => {
    localStorage.clear()
    Object.assign(window, { __CLAXEDO__: { serverUrl: location.origin, activeDirectory: dir } })
    localStorage.setItem("claxedo.global.dat:server", JSON.stringify({ list: [], projects: { local: [{ worktree: dir, expanded: true }] }, lastProject: {}, workspaceServer: {}, closedProjects: {} }))
  }, { dir: DIR })
  type Row = { seq: number; messageId: string; held: boolean; parts: Array<{ type: string; text: string }> }
  let rows: Row[] = []
  const actions: string[] = []
  await page.route(/\/session\/[^/]+\/queue(?:\/\d+\/(?:cancel|steer|replace|hold|release))?(?:\?.*)?$/, async (route) => {
    const action = new URL(route.request().url()).pathname.match(/queue\/(\d+)\/(cancel|steer|replace|hold|release)$/)
    if (!action) return route.fulfill({ json: rows })
    const seq = Number(action[1])
    actions.push(action[2])
    if (action[2] === "replace") {
      const body = route.request().postDataJSON() as { parts: Row["parts"] }
      rows = rows.map((row) => (row.seq === seq ? { ...row, parts: body.parts, held: false } : row))
    } else if (action[2] === "hold" || action[2] === "release") {
      rows = rows.map((row) => (row.seq === seq ? { ...row, held: action[2] === "hold" } : row))
    } else {
      rows = rows.filter((row) => row.seq !== seq)
    }
    await route.fulfill({ json: { ok: true } })
  })
  const slug = Buffer.from(DIR).toString("base64url")
  await page.goto(`/${slug}/session`)
  await expect(page.locator("[data-claxedo]")).toBeVisible()
  const composer = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await ensureComposerModelSelected(page)
  await composer.fill("Begin active turn")
  await page.locator(`${SELECTORS.submitControl}:visible`).last().click()
  await expect.poll(() => mock.requests.promptBodies.length).toBe(1)
  await expect(page.locator('[data-slot="session-turn-thinking"]')).toBeVisible()
  await page.route("**/prompt_async**", async (route) => {
    const body = route.request().postDataJSON()
    expect(body.delivery).toBe("queue")
    rows.push({ seq: rows.length + 1, messageId: body.messageID, held: false, parts: body.parts })
    await route.fulfill({ json: { delivery: "queue" } })
  })
  for (const text of ["Queued one", "Queued two"]) {
    await composer.fill(text)
    await page.locator(`${SELECTORS.submitControl}:visible`).last().click()
    await expect(composer).toHaveText("")
  }
  const timeline = page.locator("[data-session-timeline-root]")
  const queued = timeline.locator("[data-queued-message]")
  await expect(queued).toHaveCount(2)
  await expect(queued.nth(0)).toContainText("Queued one")
  await expect(queued.nth(1)).toContainText("Queued two")
  // Queued rows are not transcript messages: only the active turn's prompt is one.
  await expect(timeline.locator('[data-component="user-message"]')).toHaveCount(1)
  await expect(queued.first().locator('[data-slot="queued-message-text"]')).toHaveCSS("opacity", "0.6")
  // Controls sit in the hover row, like a sent message's copy button.
  const actionsRow = queued.first().locator('[data-slot="queued-message-actions"]')
  await expect(actionsRow).toHaveCSS("opacity", "0")
  await queued.first().hover()
  await expect(actionsRow).toHaveCSS("opacity", "1")
  await expect(page.locator('[data-testid="composer-queued"]')).toHaveCount(0)

  await actionsRow.getByRole("button", { name: "Remove" }).click()
  await expect(queued).toHaveCount(1)
  await expect(queued.first()).toContainText("Queued two")

  // Editing holds the message on the runtime; Escape gives it back untouched.
  await queued.first().hover()
  await queued.first().getByRole("button", { name: "Edit" }).click()
  await expect(composer).toHaveText("Queued two")
  await expect(queued.first()).toHaveAttribute("data-editing", "true")
  await expect(queued.first()).toContainText("Editing")
  expect(rows[0]?.held).toBe(true)
  await composer.fill("Queued two, abandoned")
  await composer.press("Escape")
  await expect(composer).toHaveText("")
  await expect(queued.first()).not.toHaveAttribute("data-editing", "true")
  await expect(queued.first()).toContainText("Queued two")
  await expect.poll(() => rows[0]?.held).toBe(false)
  expect(mock.requests.abortCount).toBe(0)

  await queued.first().hover()
  await queued.first().getByRole("button", { name: "Edit" }).click()
  await expect(composer).toHaveText("Queued two")
  await composer.fill("Queued two, edited")
  await page.locator(`${SELECTORS.submitControl}:visible`).last().click()
  await expect(composer).toHaveText("")
  await expect(queued).toHaveCount(1)
  await expect(queued.first()).toContainText("Queued two, edited")
  await expect(queued.first()).not.toHaveAttribute("data-editing", "true")
  expect(rows[0]?.parts.map((part) => part.text)).toEqual(["Queued two, edited"])
  expect(rows[0]?.held).toBe(false)

  await queued.first().hover()
  await queued.first().getByRole("button", { name: "Send now" }).click()
  await expect(queued).toHaveCount(0)
  expect(actions).toEqual(["cancel", "hold", "release", "hold", "replace", "steer"])
})

test("@core queued bubbles leave the virtual rows alone, do not move a reader who scrolled up, and yield to the admitted row without a duplicate", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 })
  const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION, projectId: "proj_mock_runtime", holdTurn: true,
    harnessModels: { opencode: [{ id: "gpt-5", name: "GPT-5" }] } })
  await page.addInitScript(({ dir }) => {
    localStorage.clear()
    Object.assign(window, { __CLAXEDO__: { serverUrl: location.origin, activeDirectory: dir } })
    localStorage.setItem("claxedo.global.dat:server", JSON.stringify({ list: [], projects: { local: [{ worktree: dir, expanded: true }] }, lastProject: {}, workspaceServer: {}, closedProjects: {} }))
  }, { dir: DIR })
  type Row = { seq: number; messageId: string; held: boolean; parts: Array<{ type: string; text: string }> }
  let rows: Row[] = []
  await page.route(/\/session\/[^/]+\/queue(?:\?.*)?$/, (route) => route.fulfill({ json: rows }))
  const slug = Buffer.from(DIR).toString("base64url")
  await page.goto(`/${slug}/session`)
  await expect(page.locator("[data-claxedo]")).toBeVisible()
  const composer = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await ensureComposerModelSelected(page)
  // A tall first prompt so the timeline overflows the 600px viewport.
  await composer.fill(Array.from({ length: 40 }, (_, i) => `line ${i + 1} of a long prompt`).join("\n"))
  await page.locator(`${SELECTORS.submitControl}:visible`).last().click()
  await expect.poll(() => mock.requests.promptBodies.length).toBe(1)
  const timeline = page.locator("[data-session-timeline-root]")
  await expect(page.locator('[data-slot="session-turn-thinking"]')).toBeVisible()
  await page.route("**/prompt_async**", async (route) => {
    const body = route.request().postDataJSON()
    rows.push({ seq: rows.length + 1, messageId: body.messageID, held: false, parts: body.parts })
    await route.fulfill({ json: { delivery: "queue" } })
  })

  const scroller = timeline.locator("[data-scrollable]").first()
  const rowCountBefore = await timeline.getAttribute("data-session-timeline-row-count")
  const keyCountBefore = await timeline.getAttribute("data-session-timeline-key-count")
  const virtualHeightBefore = await page.locator("[data-timeline-virtual-content]").evaluate((el) => el.style.height)

  // A reader scrolled back up while another client queues a message (a send
  // from this composer resumes bottom-following on purpose, so it is not the
  // case to measure): what they are reading must not move.
  const box = (await scroller.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, -8000)
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(0)
  await page.waitForTimeout(400)
  const line1 = timeline.locator('[data-component="user-message"]').first()
  const line1Before = (await line1.boundingBox())!.y
  rows.push({ seq: 1, messageId: "msg_queued_elsewhere", held: false, parts: [{ type: "text", text: "Queued while reading" }] })
  const queued = timeline.locator("[data-queued-message]")
  await expect(queued).toHaveCount(1)
  await page.waitForTimeout(300)
  expect((await line1.boundingBox())!.y).toBe(line1Before)
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(0)
  // The virtual list itself is untouched: same rows, same keys, same height.
  expect(await timeline.getAttribute("data-session-timeline-row-count")).toBe(rowCountBefore)
  expect(await timeline.getAttribute("data-session-timeline-key-count")).toBe(keyCountBefore)
  expect(await page.locator("[data-timeline-virtual-content]").evaluate((el) => el.style.height)).toBe(virtualHeightBefore)

  // Admission: the runtime starts the queued prompt and its user message lands
  // over events before the queue poll drops the record. The bubble must yield
  // in the same step, with the record still listed by the server.
  const messageId = rows[0]!.messageId
  mock.emit({ type: "message.updated", properties: { sessionID: SESSION, info: {
    id: messageId, sessionID: SESSION, role: "user", time: { created: Date.now() }, agent: "build",
    model: { providerID: "opencode", modelID: "gpt-5" },
  } } })
  mock.emit({ type: "message.part.updated", properties: { sessionID: SESSION, time: Date.now(), part: {
    id: `${messageId}_text`, sessionID: SESSION, messageID: messageId, type: "text", text: "Queued while reading",
  } } })
  await expect(timeline.locator('[data-component="user-message"]', { hasText: "Queued while reading" })).toHaveCount(1)
  await expect(queued).toHaveCount(0)
  expect(rows).toHaveLength(1)
  await page.waitForTimeout(1200)
  await expect(queued).toHaveCount(0)
  await expect(timeline.locator('[data-component="user-message"]', { hasText: "Queued while reading" })).toHaveCount(1)
})
