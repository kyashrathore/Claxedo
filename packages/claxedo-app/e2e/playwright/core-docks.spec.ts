/**
 * Session composer docks: permission, question wizard, and todo tray.
 *
 * A blocking permission or question request removes the whole composer subtree from the
 * DOM; the docks render outside that gate. The shared mock's turn stream is not gated by
 * permission resolution, so dock and reply are asserted as independent facts.
 */
import { expect, test, type Page } from "@playwright/test"
import { writeFile } from "node:fs/promises"
import { installMockRuntime, type MockRuntimeHandles } from "../helpers/mock-runtime"
import { sampleElementDuringAction } from "../helpers/geometry-oracle"
import { expectRailRowVisible } from "../helpers/rail-oracle"
import { expectAssistantReplyVisible, ensureComposerModelSelected, SELECTORS } from "../helpers/turn-oracle"

const DIR = "/tmp/e2e-core-docks"
const SESSION_ID = "ses_core_docks"

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

async function seedOneProject(page: Page, dir: string) {
  await page.addInitScript((d: string) => {
    localStorage.clear()
    ;(window as typeof window & { __CLAXEDO__?: { serverUrl?: string; activeDirectory?: string } }).__CLAXEDO__ = {
      serverUrl: window.location.origin,
      activeDirectory: d,
    }
    localStorage.setItem(
      "claxedo.global.dat:server",
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

async function openDraftPrompt(page: Page, dir: string) {
  await page.goto(`/${slug(dir)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await expect(input).toBeVisible({ timeout: 20_000 })
  return input
}

function sessionUrlPattern(sessionId: string) {
  return new RegExp(`(?:/s/${sessionId}|/w/[^/]+/session/${sessionId})$`)
}

async function sendMessage(page: Page, text: string) {
  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await expect(input).toBeVisible({ timeout: 20_000 })
  await ensureComposerModelSelected(page)
  await input.click()
  await input.fill(text)
  await expect(input).toContainText(text, { timeout: 10_000 })
  await page.locator(SELECTORS.submitControl).last().click()
}

type DockRequestCounters = {
  permissionRespond: { count: number; bodies: unknown[] }
  questionReply: { count: number; bodies: unknown[] }
  questionReject: { count: number; bodies: unknown[] }
}

async function installDockMutationRoutes(page: Page, mock: MockRuntimeHandles): Promise<DockRequestCounters> {
  const counters: DockRequestCounters = {
    permissionRespond: { count: 0, bodies: [] },
    questionReply: { count: 0, bodies: [] },
    questionReject: { count: 0, bodies: [] },
  }

  await page.route("**/session/*/permissions/*", async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    const match = new URL(route.request().url()).pathname.match(/^\/session\/([^/]+)\/permissions\/([^/]+)$/)
    if (!match) return route.fallback()
    const [, sessionID, permissionID] = match
    counters.permissionRespond.count += 1
    counters.permissionRespond.bodies.push(route.request().postDataJSON())
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) })
    // The decide POST does not clear the request; only `permission.replied` does.
    mock.emit({ type: "permission.replied", properties: { sessionID, requestID: permissionID } })
  })

  await page.route("**/question/*/reply**", async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    const match = new URL(route.request().url()).pathname.match(/^\/question\/([^/]+)\/reply$/)
    if (!match) return route.fallback()
    counters.questionReply.count += 1
    counters.questionReply.bodies.push(route.request().postDataJSON())
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) })
    // The dock clears optimistically, but the mock replays its log on every SSE
    // reconnect; without a logged `question.replied` the replayed `question.asked`
    // revives the dock.
    mock.emit({ type: "question.replied", properties: { sessionID: SESSION_ID, requestID: match[1] } })
  })

  await page.route("**/question/*/reject**", async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    const match = new URL(route.request().url()).pathname.match(/^\/question\/([^/]+)\/reject$/)
    if (!match) return route.fallback()
    counters.questionReject.count += 1
    counters.questionReject.bodies.push(route.request().postDataJSON())
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) })
    mock.emit({ type: "question.rejected", properties: { sessionID: SESSION_ID, requestID: match[1] } })
  })

  return counters
}

/** Installs the mock, seeds one project, and settles turn 1. Pinned to `gpt-5`: with
 * only the `big-pickle` placeholder resolved the first send is deferred, the legacy
 * route redirect wins, and the mocked session is never created. */
async function establishSession(page: Page, options: Parameters<typeof installMockRuntime>[1] = {}) {
  const mock = await installMockRuntime(page, {
    dir: DIR,
    sessionId: SESSION_ID,
    harnessModels: { opencode: [{ id: "gpt-5", name: "GPT-5" }] },
    ...options,
  })
  const counters = await installDockMutationRoutes(page, mock)

  await seedOneProject(page, DIR)
  await openDraftPrompt(page, DIR)

  await sendMessage(page, "core docks establishing turn")
  await expect(page).toHaveURL(sessionUrlPattern(SESSION_ID), { timeout: 20_000 })
  await expectAssistantReplyVisible(page, "ack 1: core docks establishing turn")

  return { mock, counters }
}

function permissionDock(page: Page) {
  return page.locator('[data-component="dock-prompt"][data-kind="permission"]')
}

function questionDock(page: Page) {
  return page.locator('[data-component="dock-prompt"][data-kind="question"]')
}

function questionOption(page: Page, label: string) {
  return page.locator('[data-slot="question-option"]', { hasText: label })
}

function composerTextbox(page: Page) {
  return page.getByRole("textbox", { name: /Ask anything/i })
}

test.describe("core docks — permission @core", () => {
  test("an approved Codex permission stays absent after switching sessions and replaying runtime events", async ({ page }, testInfo) => {
    const otherSessionId = "ses_permission_other"
    const mock = await installMockRuntime(page, {
      dir: DIR, sessionId: SESSION_ID, harness: "codex-app-server",
      otherSessions: [{ id: otherSessionId, title: "Other permission session", prompt: "Other prompt", reply: "Other completed reply" }],
    })
    await seedOneProject(page, DIR)
    await openDraftPrompt(page, DIR)
    await sendMessage(page, "permission replay probe")
    await expectAssistantReplyVisible(page, "ack 1: permission replay probe", { spec: "core-docks", scenario: `permission-first-${testInfo.repeatEachIndex}` })
    const requestId = "permission_runtime_replay"
    mock.emit({
      type: "permission.asked",
      properties: { id: requestId, sessionID: SESSION_ID, permission: "command", patterns: ["/tmp/qa-permission"], metadata: { command: "printf QA > /tmp/qa-permission" }, always: [] },
    })
    mock.emitRuntime({
      directory: DIR, sessionId: SESSION_ID,
      payload: { type: "permission-request", requestId, tool: "command", paths: ["/tmp/qa-permission"], details: { command: "printf QA > /tmp/qa-permission" } },
    })
    await expect(permissionDock(page)).toBeVisible({ timeout: 20_000 })
    await page.getByRole("button", { name: "Allow once", exact: true }).click()
    await expect.poll(() => mock.requests.permissionResponses).toEqual(["once"])
    mock.emit({ type: "permission.replied", properties: { sessionID: SESSION_ID, requestID: requestId } })
    await expect(permissionDock(page)).toHaveCount(0)
    const otherRow = await expectRailRowVisible({ page, sessionId: otherSessionId })
    const otherStream = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname.endsWith("/api/wr/runtime-events") && url.searchParams.get("parentSessionId") === otherSessionId && response.status() === 200
    })
    await otherRow.click()
    await expect(page).toHaveURL(sessionUrlPattern(otherSessionId))
    await otherStream
    await expectAssistantReplyVisible(page, "Other completed reply", { spec: "core-docks", scenario: `permission-other-${testInfo.repeatEachIndex}` })
    const row = await expectRailRowVisible({ page, sessionId: SESSION_ID })
    const samples = await sampleElementDuringAction(page, '[data-component="dock-prompt"][data-kind="permission"]', async () => {
      const replay = page.waitForResponse(async response => new URL(response.url()).pathname.endsWith("/api/wr/runtime-events") && response.status() === 200 && (await response.text()).includes(requestId))
      await row.click()
      await expect(page).toHaveURL(sessionUrlPattern(SESSION_ID))
      await replay
      await expectAssistantReplyVisible(page, "ack 1: permission replay probe", { spec: "core-docks", scenario: `permission-return-${testInfo.repeatEachIndex}` })
    })
    await writeFile(testInfo.outputPath("permission-return-frames.json"), JSON.stringify(samples, null, 2))
    await page.screenshot({ path: testInfo.outputPath("permission-return.png") })
    expect(mock.requests.permissionResponses).toEqual(["once"])
    expect(mock.requests.unhandled).toEqual([])
    expect(samples.length).toBeGreaterThan(2)
    expect(samples.filter(sample => sample.visible > 0), "approved permission repaints during rail return").toEqual([])
  })

  test("permission dock blocks the composer; Allow once resolves it and the in-flight turn still completes visibly", async ({
    page,
  }) => {
    const { mock, counters } = await establishSession(page)

    await sendMessage(page, "core docks second turn")

    mock.emit({
      type: "permission.asked",
      properties: {
        id: "perm_allow_once",
        sessionID: SESSION_ID,
        permission: "edit",
        patterns: ["src/**/*.ts"],
        metadata: {},
        always: [],
      },
    })

    await expect(permissionDock(page)).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-slot="permission-header-title"]')).toHaveText("Permission required")
    await expect(page.locator('[data-slot="permission-hint"]')).toHaveText(
      "Modify files, including edits, writes, and patches",
    )
    await expect(page.locator('[data-slot="permission-patterns"]')).toContainText("src/**/*.ts")

    await expect(composerTextbox(page)).toHaveCount(0)
    await expect(page.locator(SELECTORS.submitControl)).toHaveCount(0)

    await page.getByRole("button", { name: "Allow once", exact: true }).click()

    await expect.poll(() => counters.permissionRespond.count, { timeout: 10_000 }).toBe(1)
    expect(counters.permissionRespond.bodies[0]).toEqual({ response: "once" })

    await expect(permissionDock(page)).toHaveCount(0, { timeout: 20_000 })
    await expect(composerTextbox(page)).toBeVisible({ timeout: 20_000 })

    await expectAssistantReplyVisible(page, "ack 2: core docks second turn")
  })

  test("Deny posts {response: reject} and the dock only clears on the server's permission.replied event", async ({
    page,
  }) => {
    const { mock, counters } = await establishSession(page)

    mock.emit({
      type: "permission.asked",
      properties: {
        id: "perm_deny",
        sessionID: SESSION_ID,
        permission: "bash",
        patterns: [],
        metadata: {},
        always: [],
      },
    })

    await expect(permissionDock(page)).toBeVisible({ timeout: 20_000 })
    await expect(composerTextbox(page)).toHaveCount(0)

    await page.getByRole("button", { name: "Deny", exact: true }).click()

    await expect.poll(() => counters.permissionRespond.count, { timeout: 10_000 }).toBe(1)
    expect(counters.permissionRespond.bodies[0]).toEqual({ response: "reject" })

    await expect(permissionDock(page)).toHaveCount(0, { timeout: 20_000 })
    await expect(composerTextbox(page)).toBeVisible({ timeout: 20_000 })
  })

  test("Allow always persists auto-accept for allowlisted permissions; a danger-gated one still surfaces a dock", async ({
    page,
  }) => {
    const { mock, counters } = await establishSession(page)

    mock.emit({
      type: "permission.asked",
      properties: {
        id: "perm_always_1",
        sessionID: SESSION_ID,
        permission: "edit",
        patterns: ["src/**/*.ts"],
        metadata: {},
        always: [],
      },
    })
    await expect(permissionDock(page)).toBeVisible({ timeout: 20_000 })

    await page.getByRole("button", { name: "Allow always", exact: true }).click()
    await expect.poll(() => counters.permissionRespond.count, { timeout: 10_000 }).toBe(1)
    expect(counters.permissionRespond.bodies[0]).toEqual({ response: "always" })
    await expect(permissionDock(page)).toHaveCount(0, { timeout: 20_000 })
    await expect(composerTextbox(page)).toBeVisible({ timeout: 20_000 })

    // `read` is a safe-read permission: the global listener answers it before the
    // composer memo would surface it, so the counter reaches 2 with no dock mounted.
    mock.emit({
      type: "permission.asked",
      properties: {
        id: "perm_always_2",
        sessionID: SESSION_ID,
        permission: "read",
        patterns: [],
        metadata: {},
        always: [],
      },
    })

    await expect.poll(() => counters.permissionRespond.count, { timeout: 10_000 }).toBe(2)
    expect(counters.permissionRespond.bodies[1]).toEqual({ response: "once" })
    await expect(permissionDock(page)).toHaveCount(0)
    await expect(composerTextbox(page)).toBeVisible()

    // Auto-accept is an allowlist: `bash` is danger-gated and must still reach the user.
    mock.emit({
      type: "permission.asked",
      properties: {
        id: "perm_always_3",
        sessionID: SESSION_ID,
        permission: "bash",
        patterns: [],
        metadata: {},
        always: [],
      },
    })

    await expect(permissionDock(page)).toBeVisible({ timeout: 20_000 })
    await expect(composerTextbox(page)).toHaveCount(0)
    expect(counters.permissionRespond.count).toBe(2)
  })

  test("a child session's permission request reaches a decision dock on the parent", async ({ page }, testInfo) => {
    const childId = "ses_child_permission"
    const mock = await installMockRuntime(page, {
      dir: DIR, sessionId: SESSION_ID,
      harnessModels: { opencode: [{ id: "gpt-5", name: "GPT-5" }] },
      existingSession: { prompt: "parent prompt", reply: "parent reply" },
      childSessions: [{ id: childId, parentId: SESSION_ID, title: "Child task", prompt: "child prompt", reply: "child reply" }],
    })
    await seedOneProject(page, DIR)
    await page.goto(`/${slug(DIR)}/session/${SESSION_ID}`)
    await expectAssistantReplyVisible(page, "parent reply")

    // The child's shell call needs approval. The runtime routes the ask with
    // the child's sessionID; the only place that can show a decision is the
    // parent's composer — the child's own tab is read-only.
    mock.emit({
      type: "permission.asked",
      properties: {
        id: "perm_child_1",
        sessionID: childId,
        permission: "bash",
        patterns: ["/tmp/child-target"],
        metadata: { command: "printf QA > /tmp/child-target" },
        always: [],
      },
    })
    await expect(permissionDock(page), "the child session's permission ask produced no decision dock on its parent").toBeVisible({ timeout: 20_000 })
    await page.screenshot({ path: testInfo.outputPath("child-permission-dock.png") })

    // Answering through the parent's dock must reach the child's request id on
    // the child's session route, then clear it.
    await page.getByRole("button", { name: "Deny", exact: true }).click()
    await expect.poll(() => mock.requests.permissionResponses, { timeout: 10_000 }).toEqual(["reject"])
    mock.emit({ type: "permission.replied", properties: { sessionID: childId, requestID: "perm_child_1" } })
    await expect(permissionDock(page)).toHaveCount(0, { timeout: 20_000 })
  })
})

test.describe("core docks — question wizard @core", () => {
  test("Codex questions answered while away stay absent on rail return", async ({ page }, testInfo) => {
    const otherSessionId = "ses_question_other"
    const mock = await installMockRuntime(page, {
      dir: DIR, sessionId: SESSION_ID, harness: "codex-app-server",
      otherSessions: [{ id: otherSessionId, title: "Other QA session", prompt: "Other prompt", reply: "Other completed reply" }],
    })
    await seedOneProject(page, DIR)
    await openDraftPrompt(page, DIR)
    await sendMessage(page, "runtime question replay probe")
    await expectAssistantReplyVisible(page, "ack 1: runtime question replay probe", { spec: "core-docks", scenario: `runtime-question-first-${testInfo.repeatEachIndex}` })
    const requestId = "q_runtime_replay"
    mock.emit({
      type: "question.asked",
      properties: {
        id: requestId, sessionID: SESSION_ID,
        questions: [{ question: "Which QA color?", header: "QA color", options: [{ label: "TEAL", description: "Select TEAL" }] }],
      },
    })
    mock.emitRuntime({
      directory: DIR, sessionId: SESSION_ID,
      payload: {
        type: "question", harness: "codex", requestId,
        questions: [{ text: "Which QA color?", header: "QA color", options: ["TEAL"] }],
      },
    })
    await expect(questionDock(page)).toBeVisible({ timeout: 20_000 })
    const otherRow = await expectRailRowVisible({ page, sessionId: otherSessionId })
    const otherStream = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname.endsWith("/api/wr/runtime-events") && url.searchParams.get("parentSessionId") === otherSessionId
    })
    await otherRow.click()
    await expect(page).toHaveURL(sessionUrlPattern(otherSessionId))
    await otherStream
    await expectAssistantReplyVisible(page, "Other completed reply", { spec: "core-docks", scenario: `runtime-question-other-${testInfo.repeatEachIndex}` })
    // A client that misses the resolution must reconcile the empty server list
    // before displaying a cached request or replaying the retained question.
    mock.clearPendingQuestion(requestId)
    const row = await expectRailRowVisible({ page, sessionId: SESSION_ID })
    const samples = await sampleElementDuringAction(page, '[data-component="dock-prompt"][data-kind="question"]', async () => {
      const replay = page.waitForResponse(async response => new URL(response.url()).pathname.endsWith("/api/wr/runtime-events") && response.status() === 200 && (await response.text()).includes(requestId))
      await row.click()
      await expect(page).toHaveURL(sessionUrlPattern(SESSION_ID))
      await replay
      await expectAssistantReplyVisible(page, "ack 1: runtime question replay probe", { spec: "core-docks", scenario: `runtime-question-return-${testInfo.repeatEachIndex}` })
    })
    await writeFile(testInfo.outputPath("runtime-question-return-frames.json"), JSON.stringify(samples, null, 2))
    await page.screenshot({ path: testInfo.outputPath("runtime-question-return.png") })
    expect(samples.length).toBeGreaterThan(2)
    expect(mock.requests.questionReplies).toHaveLength(0)
    expect(mock.requests.unhandled).toEqual([])
    expect(samples.filter(sample => sample.visible > 0), "resolved runtime question repaints during rail return").toEqual([])
  })

  test("an answered question stays absent on every frame when returning through the rail", async ({ page }, testInfo) => {
    const { mock, counters } = await establishSession(page)
    mock.emit({
      type: "question.asked",
      properties: {
        id: "q_answered_navigation",
        sessionID: SESSION_ID,
        questions: [{
          question: "Which approach should I take?",
          header: "Approach",
          options: [{ label: "Careful", description: "Take more time" }],
          multiple: false,
        }],
      },
    })
    await expect(questionDock(page)).toBeVisible({ timeout: 20_000 })
    await questionOption(page, "Careful").click()
    await page.getByRole("button", { name: "Submit", exact: true }).click()
    await expect.poll(() => counters.questionReply.count).toBe(1)
    expect(counters.questionReply.bodies).toEqual([{ answers: [["Careful"]] }])
    await expect(questionDock(page)).toHaveCount(0)
    await page.getByRole("button", { name: "New Session", exact: true }).last().click()
    await expect(page).toHaveURL(/\/session$/)
    const row = await expectRailRowVisible({ page, sessionId: SESSION_ID })
    const samples = await sampleElementDuringAction(page, '[data-component="dock-prompt"][data-kind="question"]', async () => {
      const nextEventBatch = page.waitForResponse(response =>
        /\/(events|runtime-events)$/.test(new URL(response.url()).pathname)
        && response.status() === 200
        && response.headers()["content-type"]?.includes("text/event-stream"),
      )
      await row.click()
      await expect(page).toHaveURL(sessionUrlPattern(SESSION_ID))
      await expectAssistantReplyVisible(page, "ack 1: core docks establishing turn")

      await nextEventBatch
    })
    await writeFile(testInfo.outputPath("answered-question-frames.json"), JSON.stringify(samples, null, 2))
    await page.screenshot({ path: testInfo.outputPath("answered-question-return.png") })
    expect(samples.length).toBeGreaterThan(2)
    expect(samples.filter(sample => sample.visible > 0), "answered question flashes during the rail return").toEqual([])
    expect(counters.questionReply.count).toBe(1)
    expect(mock.requests.unhandled).toEqual([])
  })

  test("single question: picking an option and Submit posts one answer array", async ({ page }) => {
    const { mock, counters } = await establishSession(page)

    mock.emit({
      type: "question.asked",
      properties: {
        id: "q_single",
        sessionID: SESSION_ID,
        questions: [
          {
            question: "Which approach should I take?",
            header: "Approach",
            options: [
              { label: "Fast", description: "Ship quickly" },
              { label: "Careful", description: "Take more time" },
            ],
            multiple: false,
          },
        ],
      },
    })

    await expect(questionDock(page)).toBeVisible({ timeout: 20_000 })
    await expect(composerTextbox(page)).toHaveCount(0)
    await expect(page.locator('[data-slot="question-header-title"]')).toHaveText("1 of 1 questions")
    await expect(page.locator('[data-slot="question-hint"]')).toHaveText("Select one answer")

    const fast = questionOption(page, "Fast")
    await fast.click()
    await expect(fast).toHaveAttribute("data-picked", "true")

    await page.getByRole("button", { name: "Submit", exact: true }).click()

    await expect.poll(() => counters.questionReply.count, { timeout: 10_000 }).toBe(1)
    expect(counters.questionReply.bodies[0]).toEqual({ answers: [["Fast"]] })

    await expect(questionDock(page)).toHaveCount(0, { timeout: 20_000 })
    await expect(composerTextbox(page)).toBeVisible({ timeout: 20_000 })
  })

  test("minimize keeps the picked answer and frees the transcript; restoring submits it", async ({ page }) => {
    const { mock, counters } = await establishSession(page)

    mock.emit({
      type: "question.asked",
      properties: {
        id: "q_minimize",
        sessionID: SESSION_ID,
        questions: [
          {
            question: "Which approach should I take?",
            header: "Approach",
            options: [
              { label: "Fast", description: "Ship quickly" },
              { label: "Careful", description: "Take more time" },
            ],
            multiple: false,
          },
        ],
      },
    })

    await expect(questionDock(page)).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-slot="question-progress-segment"]')).toHaveCount(0)

    await questionOption(page, "Fast").click()
    await expect(questionOption(page, "Fast")).toHaveAttribute("data-picked", "true")

    const expanded = await questionDock(page).boundingBox()
    await page.getByRole("button", { name: "Collapse question", exact: true }).click()

    await expect(questionDock(page)).toHaveAttribute("data-collapsed", "true")
    await expect(page.locator('[data-slot="question-option"]')).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Submit", exact: true })).toHaveCount(0)
    await expect(page.locator('[data-slot="question-header-preview"]')).toHaveText("Which approach should I take?")
    expect((await questionDock(page).boundingBox())!.height).toBeLessThan(expanded!.height)
    await expect(page.getByText("ack 1: core docks establishing turn").last()).toBeVisible()

    await page.getByRole("button", { name: "Expand question", exact: true }).click()
    await expect(questionOption(page, "Fast")).toHaveAttribute("data-picked", "true")

    await page.getByRole("button", { name: "Submit", exact: true }).click()
    await expect.poll(() => counters.questionReply.count, { timeout: 10_000 }).toBe(1)
    expect(counters.questionReply.bodies[0]).toEqual({ answers: [["Fast"]] })
  })

  test("multi-question: Back/Next preserve per-tab answers; a multiple:true question toggles independently", async ({
    page,
  }) => {
    const { mock, counters } = await establishSession(page)

    mock.emit({
      type: "question.asked",
      properties: {
        id: "q_multi",
        sessionID: SESSION_ID,
        questions: [
          {
            question: "Continue after reload?",
            header: "Coordination",
            options: [
              { label: "Proceed", description: "Continue the same chat" },
              { label: "Stop", description: "Do not continue" },
            ],
            multiple: false,
          },
          {
            question: "Which areas need review?",
            header: "Review scope",
            options: [
              { label: "Alpha", description: "Area one" },
              { label: "Bravo", description: "Area two" },
              { label: "Charlie", description: "Area three" },
            ],
            multiple: true,
          },
        ],
      },
    })

    await expect(questionDock(page)).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-slot="question-header-title"]')).toHaveText("1 of 2 questions")

    await questionOption(page, "Proceed").click()
    await expect(questionOption(page, "Proceed")).toHaveAttribute("data-picked", "true")

    await page.getByRole("button", { name: "Next", exact: true }).click()
    await expect(page.locator('[data-slot="question-header-title"]')).toHaveText("2 of 2 questions")
    await expect(page.locator('[data-slot="question-hint"]')).toHaveText("Select all answers that apply")

    await questionOption(page, "Alpha").click()
    await questionOption(page, "Bravo").click()
    await expect(questionOption(page, "Alpha")).toHaveAttribute("data-picked", "true")
    await expect(questionOption(page, "Bravo")).toHaveAttribute("data-picked", "true")
    await expect(questionOption(page, "Charlie")).not.toHaveAttribute("data-picked", "true")

    await page.getByRole("button", { name: "Back", exact: true }).click()
    await expect(page.locator('[data-slot="question-header-title"]')).toHaveText("1 of 2 questions")
    await expect(questionOption(page, "Proceed")).toHaveAttribute("data-picked", "true")

    await page.getByRole("button", { name: "Next", exact: true }).click()
    await expect(page.locator('[data-slot="question-header-title"]')).toHaveText("2 of 2 questions")
    await expect(questionOption(page, "Alpha")).toHaveAttribute("data-picked", "true")
    await expect(questionOption(page, "Bravo")).toHaveAttribute("data-picked", "true")

    await page.getByRole("button", { name: "Submit", exact: true }).click()

    await expect.poll(() => counters.questionReply.count, { timeout: 10_000 }).toBe(1)
    expect(counters.questionReply.bodies[0]).toEqual({ answers: [["Proceed"], ["Alpha", "Bravo"]] })
    await expect(questionDock(page)).toHaveCount(0, { timeout: 20_000 })
  })

  test("custom answer: typing and committing sets the tab's answer to the typed text", async ({ page }) => {
    const { mock, counters } = await establishSession(page)

    mock.emit({
      type: "question.asked",
      properties: {
        id: "q_custom",
        sessionID: SESSION_ID,
        questions: [
          {
            question: "How should I proceed?",
            header: "Proceed",
            options: [{ label: "Default", description: "Use the default plan" }],
            multiple: false,
          },
        ],
      },
    })

    await expect(questionDock(page)).toBeVisible({ timeout: 20_000 })

    const custom = page.locator('[data-slot="question-option"][data-custom="true"]')
    await expect(custom).toHaveText(/Type your own answer/)
    await custom.click()

    const input = page.locator('[data-slot="question-custom-input"]')
    await expect(input).toBeVisible({ timeout: 10_000 })
    await input.fill("Use approach C")
    await input.press("Enter")

    await expect(custom).toHaveAttribute("data-picked", "true")
    await expect(custom).toContainText("Use approach C")

    await page.getByRole("button", { name: "Submit", exact: true }).click()

    await expect.poll(() => counters.questionReply.count, { timeout: 10_000 }).toBe(1)
    expect(counters.questionReply.bodies[0]).toEqual({ answers: [["Use approach C"]] })
  })

  test("Dismiss and Escape both reject the wizard optimistically, no permission SSE round-trip required", async ({
    page,
  }) => {
    const { mock, counters } = await establishSession(page)

    mock.emit({
      type: "question.asked",
      properties: {
        id: "q_dismiss",
        sessionID: SESSION_ID,
        questions: [
          {
            question: "Dismiss me via button",
            header: "Dismiss",
            options: [{ label: "One", description: "First" }],
            multiple: false,
          },
        ],
      },
    })
    await expect(questionDock(page)).toBeVisible({ timeout: 20_000 })

    await page.getByRole("button", { name: "Dismiss", exact: true }).click()
    await expect.poll(() => counters.questionReject.count, { timeout: 10_000 }).toBe(1)
    await expect(questionDock(page)).toHaveCount(0, { timeout: 20_000 })
    await expect(composerTextbox(page)).toBeVisible({ timeout: 20_000 })

    mock.emit({
      type: "question.asked",
      properties: {
        id: "q_escape",
        sessionID: SESSION_ID,
        questions: [
          {
            question: "Dismiss me via Escape",
            header: "Escape",
            options: [{ label: "One", description: "First" }],
            multiple: false,
          },
        ],
      },
    })
    await expect(questionDock(page)).toBeVisible({ timeout: 20_000 })

    // The dock focuses its first option in a requestAnimationFrame after mount; an
    // Escape pressed before that bubbles from body and rejects nothing.
    await expect(questionDock(page).locator('[data-slot="question-option"]').first()).toBeFocused({
      timeout: 10_000,
    })
    await page.keyboard.press("Escape")
    await expect.poll(() => counters.questionReject.count, { timeout: 10_000 }).toBe(2)
    await expect(questionDock(page)).toHaveCount(0, { timeout: 20_000 })
  })

  test("keyboard: Arrow/Home/End move focus among options + custom, Enter activates the focused option", async ({
    page,
  }) => {
    const { mock } = await establishSession(page)

    mock.emit({
      type: "question.asked",
      properties: {
        id: "q_keyboard",
        sessionID: SESSION_ID,
        questions: [
          {
            question: "Pick one",
            header: "Pick",
            options: [
              { label: "One", description: "First" },
              { label: "Two", description: "Second" },
            ],
            multiple: false,
          },
        ],
      },
    })
    await expect(questionDock(page)).toBeVisible({ timeout: 20_000 })

    const one = questionOption(page, "One")
    const two = questionOption(page, "Two")
    const custom = page.locator('[data-slot="question-option"][data-custom="true"]')

    await expect(one).toBeFocused({ timeout: 10_000 })

    await page.keyboard.press("ArrowDown")
    await expect(two).toBeFocused({ timeout: 5_000 })

    await page.keyboard.press("ArrowDown")
    await expect(custom).toBeFocused({ timeout: 5_000 })

    await page.keyboard.press("Home")
    await expect(one).toBeFocused({ timeout: 5_000 })

    await page.keyboard.press("End")
    await expect(custom).toBeFocused({ timeout: 5_000 })

    await page.keyboard.press("ArrowUp")
    await expect(two).toBeFocused({ timeout: 5_000 })

    await page.keyboard.press("Enter")
    await expect(two).toHaveAttribute("data-picked", "true")
    await expect(one).not.toHaveAttribute("data-picked", "true")
  })

  test("in-progress answers survive the dock's unmount/remount for the same request id", async ({
    page,
  }) => {
    const { mock } = await establishSession(page)

    const questionProps = {
      id: "q_persist",
      sessionID: SESSION_ID,
      questions: [
        {
          question: "Continue after reload?",
          header: "Coordination",
          options: [
            { label: "Proceed", description: "Continue the same chat" },
            { label: "Stop", description: "Do not continue" },
          ],
          multiple: false,
        },
        {
          question: "Second question",
          header: "Second",
          options: [{ label: "Yep", description: "Confirmed" }],
          multiple: false,
        },
      ],
    }

    mock.emit({ type: "question.asked", properties: questionProps })
    await expect(questionDock(page)).toBeVisible({ timeout: 20_000 })

    await questionOption(page, "Proceed").click()
    await page.getByRole("button", { name: "Next", exact: true }).click()
    await expect(page.locator('[data-slot="question-header-title"]')).toHaveText("2 of 2 questions")

    // Re-emitting the same id as a fresh object replaces the cache entry, so the keyed
    // `Show` remounts the dock: the same remount a navigate-away-and-back triggers.
    mock.emit({ type: "question.asked", properties: { ...questionProps } })

    await expect(questionDock(page)).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-slot="question-header-title"]')).toHaveText("2 of 2 questions")

    await page.getByRole("button", { name: "Back", exact: true }).click()
    await expect(page.locator('[data-slot="question-header-title"]')).toHaveText("1 of 2 questions")
    await expect(questionOption(page, "Proceed")).toHaveAttribute("data-picked", "true")
  })
})

test.describe("core docks — todo tray @core", () => {
  test("todo dock preserves all five completed steps after the turn ends and reloads", async ({
    page,
  }, testInfo) => {
    const { mock } = await establishSession(page)

    mock.emit({ type: "session.status", properties: { sessionID: SESSION_ID, status: { type: "busy" } } })
    mock.emit({
      type: "todo.updated",
      properties: {
        sessionID: SESSION_ID,
        todos: [
          { content: "Set up scaffold", status: "completed", priority: "low" },
          { content: "Wire the API", status: "in_progress", priority: "medium" },
          { content: "Write tests", status: "pending", priority: "low" },
          { content: "Review results", status: "pending", priority: "low" },
          { content: "Finish task", status: "pending", priority: "low" },
        ],
      },
    })

    const dock = page.locator('[data-component="session-todo-dock"]')
    await expect(dock).toBeVisible({ timeout: 20_000 })

    const progressLabel = page.locator('[data-action="session-todo-toggle"] span[aria-label]').first()
    await expect(progressLabel).toHaveAttribute("aria-label", "1 of 5 todos completed")

    const list = page.locator('[data-slot="session-todo-list"]')
    await expect(list).toHaveAttribute("aria-hidden", "false")
    await expect(list.locator('[data-component="checkbox"]')).toHaveCount(5)
    await expect(list.locator('[data-component="checkbox"][data-state="in_progress"]')).toContainText("Wire the API")

    await page.locator('[data-action="session-todo-toggle-button"]').click()
    await expect(list).toHaveAttribute("aria-hidden", "true", { timeout: 10_000 })
    const preview = page.locator('[data-slot="session-todo-preview"] [data-component="text-reveal"]')
    await expect(preview).toHaveAttribute("aria-label", "Wire the API", { timeout: 10_000 })

    mock.emit({
      type: "todo.updated",
      properties: {
        sessionID: SESSION_ID,
        todos: [
          { content: "Set up scaffold", status: "completed", priority: "low" },
          { content: "Wire the API", status: "completed", priority: "medium" },
          { content: "Write tests", status: "completed", priority: "low" },
          { content: "Review results", status: "completed", priority: "low" },
          { content: "Finish task", status: "completed", priority: "low" },
        ],
      },
    })

    mock.emit({ type: "session.status", properties: { sessionID: SESSION_ID, status: { type: "idle" } } })
    // The completed batch is delivered when the dock reads 5 of 5 — the events
    // stream is a persistent fetch whose response body never completes, so the
    // wire itself cannot be sniffed from a finished response.
    await expect(progressLabel, "the completed batch was delivered before reload").toHaveAttribute(
      "aria-label",
      "5 of 5 todos completed",
      { timeout: 20_000 },
    )
    await page.reload()
    await expectAssistantReplyVisible(page, "ack 1: core docks establishing turn")
    await page.screenshot({ path: testInfo.outputPath("completed-todos-after-reload.png") })
    await expect(dock, "completed task retains its final todo surface").toBeVisible({ timeout: 10_000 })
    await expect(progressLabel).toHaveAttribute("aria-label", "5 of 5 todos completed")
    if (await list.getAttribute("aria-hidden") === "true") {
      await page.locator('[data-action="session-todo-toggle-button"]').click()
    }
    await expect(list).toHaveAttribute("aria-hidden", "false")
    await expect(list.locator('[data-component="checkbox"]')).toHaveCount(5)
    await expect(list.locator('[data-component="checkbox"][data-state="completed"]')).toHaveCount(5)
    // TextStrikethrough renders its label twice (base + aria-hidden overlay);
    // read the non-hidden span so textContent isn't doubled.
    await expect(list.locator('[data-component="text-strikethrough"] > span:not([aria-hidden])')).toHaveText([
      "Set up scaffold", "Wire the API", "Write tests", "Review results", "Finish task",
    ])
  })
})
