import type { Page } from "@playwright/test"
import { installPaintedFrames } from "../harness/painted-frames"
import { acpScriptToken, assistantText, expect, SCRIPTED_ACP_CONNECTION_ID, SCRIPTED_ACP_HARNESS, sendPrompt, sessionRoute, test, UI } from "../harness"

type FirstPaintWindow = Window & { __firstTranscriptPaint?: Promise<string> }

async function firstPaintedTranscript(app: Page, sessionId: string): Promise<() => Promise<string>> {
  await app.evaluate((id) => {
    const paintedFrames = window.__claxedoPaintedFrames
    if (!paintedFrames) throw new Error("installPaintedFrames has not run in this page")
    ;(window as FirstPaintWindow).__firstTranscriptPaint = new Promise<string>((resolve) => {
      paintedFrames({
        sample: () => {
          const root = document.querySelector<HTMLElement>(`[data-testid="session-page-root"][data-session-id="${id}"]`)
          if (!root?.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true }) || !root.querySelector("[data-timeline-key]")) return undefined
          return root.querySelector("[data-session-timeline-root]")?.textContent ?? ""
        },
        painted: (text) => {
          if (text === undefined) return false
          resolve(text)
          return true
        },
      })
    })
  }, sessionId)
  return () => app.evaluate(() => (window as FirstPaintWindow).__firstTranscriptPaint!)
}

type SentFramesWindow = Window & { __sentFrames?: Promise<boolean[]> }

async function recordSentMessage(app: Page, text: string): Promise<() => Promise<boolean[]>> {
  await app.evaluate(installPaintedFrames)
  await app.evaluate((needle) => {
    const paintedFrames = window.__claxedoPaintedFrames
    if (!paintedFrames) throw new Error("installPaintedFrames has not run in this page")
    ;(window as SentFramesWindow).__sentFrames = new Promise<boolean[]>((resolve) => {
      const frames: boolean[] = []
      paintedFrames({
        sample: () => ({
          sent: [...document.querySelectorAll('[data-component="user-message"]')].some((node) => node.textContent?.includes(needle) && node.checkVisibility({ opacityProperty: true, visibilityProperty: true })),
          answered: document.querySelector('[data-testid="session-page-root"] [data-component="text-part"]') !== null,
        }),
        painted: (frame) => {
          frames.push(frame.sent)
          if (!frame.answered && frames.length <= 3000) return false
          resolve(frames)
          return true
        },
      })
    })
  }, text)
  return () => app.evaluate(() => (window as SentFramesWindow).__sentFrames!)
}

function sessionWrites(app: Page): string[] {
  const writes: string[] = []
  app.on("request", (request) => {
    const path = new URL(request.url()).pathname
    if (request.method() === "POST" && /^\/session(\/[^/]+\/(prompt_async|goal|message))?$/.test(path)) writes.push(path.replace(/\/session\/[^/]+\//, "/session/:id/"))
  })
  return writes
}

const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

test("03 send a turn: the reply streams in with its tool groups, diff, todo list, image, math and Mermaid", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("turn")
  await stack.acp.write("turn", {
    steps: [
      { kind: "reasoning", text: "Reading the project first" },
      { kind: "tool", tool: "read", title: "Read README.md", locations: [{ path: `${workspace.directory}/README.md` }], text: "turn\n" },
      { kind: "tool", tool: "search", title: "Search for TODO", input: { pattern: "TODO" }, text: "README.md:1: TODO" },
      { kind: "tool", tool: "execute", title: "git status", input: { command: "git status" }, text: "nothing to commit" },
      { kind: "tool", tool: "fetch", title: "Fetch https://example.com", input: { url: "https://example.com" }, text: "Example Domain" },
      { kind: "diff", path: `${workspace.directory}/notes.md`, oldText: null, newText: "# Notes\n" },
      { kind: "plan", entries: [{ content: "Write the notes", priority: "medium", status: "completed" }] },
      { kind: "image", data: PIXEL, mimeType: "image/png" },
      { kind: "text", text: "Done. The sum is shown below.\n\n$$a+b$$\n\n```mermaid\ngraph TD\n  A-->B\n```\n", chunks: 4 },
    ],
  })
  const session = await api.createSession(workspace.directory, { title: "Send a turn", harness: SCRIPTED_ACP_HARNESS })

  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await sendPrompt(app, `Write the notes. ${acpScriptToken("turn")}`)

  await expect(app.getByText("Write the notes.", { exact: false }).first()).toBeVisible()
  await expect(app.getByText("Done. The sum is shown below.")).toBeVisible()
  await expect(app.getByRole("math").first()).toBeVisible()
  await expect(app.getByRole("button", { name: "Open diagram full screen" })).toBeVisible()
  await expect(app.getByRole("img", { name: "image.png" })).toBeVisible()
  await test.step("a finished todo list goes away (DECISIONS Owner, 20:28)", async () => {
    await expect(app.locator('[data-component="session-todo-dock"]')).toHaveCount(0)
  })
  await app.getByRole("button", { name: UI.workedFor }).click()
  await app.getByRole("button", { name: "Edited 1 file · ran 1 command · fetched 1 page · search" }).click()
  await expect(app.getByText("git status").first()).toBeVisible()
  await expect(app.getByText("notes.md").first()).toBeVisible()
  await app.getByRole("button", { name: UI.explored }).click()
  await expect(app.getByText("README.md").first()).toBeVisible()
  await expect(app.getByRole("button", { name: UI.sendIdle })).toBeVisible()

  const messages = await api.messages(workspace.directory, session.id)
  expect(assistantText(messages)).toContain("Done. The sum is")

  await test.step("sending after reading expanded tools resumes following the reply", async () => {
    await stack.acp.write("follow-up", { steps: [{ kind: "text", text: "The follow-up is visible without jumping or reloading." }] })
    await sendPrompt(app, `Confirm the notes. ${acpScriptToken("follow-up")}`)
    await expect(app.getByText("The follow-up is visible without jumping or reloading.", { exact: true })).toBeInViewport()
    expect(assistantText(await api.messages(workspace.directory, session.id))).toContain("The follow-up is visible without jumping or reloading.")
  })
})

test("03 thinking streams open while the model thinks, then folds to how long it took", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("thinking")
  await stack.acp.write("thinking", {
    steps: [
      { kind: "reasoning", text: "**Planning**\n\nRead the config before touching the types." },
      { kind: "hold", name: "thinking" },
      { kind: "text", text: "The config is fine." },
    ],
  })
  const session = await api.createSession(workspace.directory, { title: "Thinking", harness: SCRIPTED_ACP_HARNESS })
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await sendPrompt(app, `Check the config. ${acpScriptToken("thinking")}`)

  const thought = app.locator('[data-component="reasoning-part"]')
  await expect(thought).toHaveAttribute("data-streaming", "true")
  await expect(thought.getByText("Read the config before touching the types.")).toBeVisible()
  await expect(thought.locator('[data-slot="collapsible-trigger"]')).toContainText("Thinking…")

  await stack.acp.release("thinking")
  await expect(app.getByText("The config is fine.")).toBeVisible()
  await expect(thought).not.toHaveAttribute("data-streaming", "true")
  await expect(thought.locator('[data-slot="collapsible-trigger"]')).toContainText(/Thought for \d/)
  await expect(thought.getByText("Read the config before touching the types.")).toBeHidden()

  const stored = (await api.messages(workspace.directory, session.id)).flatMap((message) => message.parts)
    .find((part) => part.type === "reasoning")
  expect(stored).toMatchObject({ text: "**Planning**\n\nRead the config before touching the types.", time: { end: expect.any(Number) } })
})

test("03 a new session's first send creates the session and its draft pane becomes that session", async ({ stack, api, app, isMobile }) => {
  const workspace = await stack.daemon.makeWorkspace("draft")
  const existing = await api.createSession(workspace.directory, { title: "Existing", harness: SCRIPTED_ACP_HARNESS })
  await app.goto(`${stack.url}${sessionRoute(workspace.id, existing.id)}`)
  const prompt = app.getByRole("textbox", { name: UI.composer })
  await expect(prompt).toBeVisible()
  await app.getByRole("button", { name: UI.newSession }).click()
  await expect(app).toHaveURL(new RegExp(`${sessionRoute(workspace.id)}$`))
  await sendPrompt(app, "Start the draft session")

  await expect(app.getByText("Start the draft session", { exact: true }).first()).toBeVisible()
  await expect.poll(async () => (await api.sessions(workspace.directory)).length).toBe(2)
  const created = (await api.sessions(workspace.directory)).find((row) => row.id !== existing.id)
  if (!created) throw new Error("the first send created no session")
  await expect(app).toHaveURL(new RegExp(`${sessionRoute(workspace.id, created.id)}$`))
  if (isMobile) await app.getByRole("button", { name: UI.openRail }).click()
  await expect.poll(async () => (await api.session(workspace.directory, created.id)).title).toBe("Scripted Session")
  await expect(app.getByRole("navigation", { name: UI.rail }).getByRole("button", { name: "Scripted Session", exact: true })).toBeVisible()
  const sent = (await api.messages(workspace.directory, created.id)).filter((message) => message.info.role === "user")
  expect(JSON.stringify(sent)).toContain("Start the draft session")
})

test("03 a draft's first send is one request: its message shows in the session layout before the session answers and stays on screen through the swap", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("one-request")
  await app.goto(`${stack.url}${sessionRoute(workspace.id)}`)
  const composer = app.getByRole("textbox", { name: UI.composer })
  const whereChip = app.getByRole("button", { name: "Where it runs", exact: true })
  await expect(whereChip).toBeVisible()
  const centered = await composer.boundingBox()
  const writes = sessionWrites(app)
  let answer!: () => void
  const answered = new Promise<void>((resolve) => { answer = resolve })
  await app.route((url) => url.pathname === "/session", async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    await answered
    await route.continue()
  })
  const text = "Start the one-request draft"
  const frames = await recordSentMessage(app, text)
  await sendPrompt(app, text)

  const message = app.locator('[data-component="user-message"]').getByText(text, { exact: true })
  await expect(message).toBeVisible()
  await expect(composer).toHaveText("")
  await expect(app.getByLabel("Thinking", { exact: true })).toBeVisible()
  await expect(whereChip).toHaveCount(0)
  const docked = await composer.boundingBox()
  const sentAt = await message.boundingBox()
  if (!centered || !docked || !sentAt) throw new Error("the composer or the sent message has no box")
  expect(docked.y).toBeGreaterThan(centered.y)
  expect(sentAt.y + sentAt.height).toBeLessThan(docked.y)
  expect(writes).toEqual(["/session"])
  answer()

  await expect.poll(async () => (await api.sessions(workspace.directory)).length).toBe(1)
  const [created] = await api.sessions(workspace.directory)
  if (!created) throw new Error("the first send created no session")
  await expect(app).toHaveURL(new RegExp(`${sessionRoute(workspace.id, created.id)}$`))
  const shown = await frames()
  const first = shown.indexOf(true)
  expect(first).toBeGreaterThanOrEqual(0)
  expect(shown.slice(first)).not.toContain(false)
  expect(writes).toEqual(["/session"])
  const sent = (await api.messages(workspace.directory, created.id)).filter((message) => message.info.role === "user")
  expect(sent).toHaveLength(1)
  expect(JSON.stringify(sent)).toContain(text)
})

test("03 a draft's first send the runtime refuses leaves no session, and its text goes back to the composer with the error", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("refused-first")
  await app.goto(`${stack.url}${sessionRoute(workspace.id)}`)
  const picker = app.locator('[data-action="prompt-harness-model"]').filter({ visible: true })
  await expect(picker).toHaveAttribute("data-harness", "pi")
  await picker.click()
  await app.getByRole("button", { name: /^Harness/ }).click()
  await app.getByRole("button", { name: "Scripted ACP" }).click()
  await expect(picker).toHaveAttribute("data-harness", "scripted-acp")
  await app.keyboard.press("Escape")
  const removed = await fetch(new URL(`/api/claxedo/agent-config/connections/${SCRIPTED_ACP_CONNECTION_ID}`, stack.url), { method: "DELETE" })
  expect(removed.status, "the draft's connection removed from another window").toBe(200)
  const text = "A first prompt to a connection removed since the draft picked it"
  await sendPrompt(app, text)

  await expect(app.getByText(`Connection "${SCRIPTED_ACP_CONNECTION_ID}" is not configured on this runtime`).filter({ visible: true }).first()).toBeVisible()
  await expect(app.getByRole("textbox", { name: UI.composer })).toHaveText(text)
  await expect(app.locator('[data-component="user-message"]')).toHaveCount(0)
  await expect(app.getByRole("button", { name: "Where it runs", exact: true })).toBeVisible()
  expect(await api.sessions(workspace.directory)).toEqual([])
  await app.reload()
  await expect(app.getByRole("textbox", { name: UI.composer })).toBeVisible()
  expect(await api.sessions(workspace.directory)).toEqual([])
  await expect(app.getByTestId("rail-sidebar-session-row")).toHaveCount(0)
})

test("03 two sessions stream at once: the second's reply shows while the first still runs, in the foreground and in the first frame after a switch", async ({ stack, api, app, isMobile }) => {
  test.skip(isMobile, "the switch goes through the desktop rail; flow 33 owns the phone rail")
  const workspace = await stack.daemon.makeWorkspace("concurrent", "Concurrent")
  const alpha = await api.createSession(workspace.directory, { title: "Alpha", harness: SCRIPTED_ACP_HARNESS })
  const bravo = await api.createSession(workspace.directory, { title: "Bravo", harness: SCRIPTED_ACP_HARNESS })
  await stack.acp.write("alpha", { steps: [{ kind: "text", text: "Alpha has started." }, { kind: "hold", name: "alpha" }, { kind: "text", text: "Alpha has finished." }] })
  await stack.acp.write("bravo", { steps: [{ kind: "text", text: "Bravo streams in the foreground.", chunks: 4, delayMs: 50 }] })
  await stack.acp.write("bravo-background", {
    steps: [
      { kind: "text", text: "Bravo starts the second reply. " },
      { kind: "hold", name: "bravo-background" },
      { kind: "text", text: `${"Bravo streams in the background. ".repeat(24)}Bravo streamed in the background.${" It keeps streaming.".repeat(40)}`, chunks: 110, delayMs: 30 },
      { kind: "hold", name: "bravo-end" },
    ],
  })
  const rail = app.getByRole("navigation", { name: UI.rail })
  const alphaText = async () => assistantText(await api.messages(workspace.directory, alpha.id))

  await app.addInitScript(installPaintedFrames)
  await app.goto(`${stack.url}${sessionRoute(workspace.id, alpha.id)}`)
  await sendPrompt(app, `Start Alpha. ${acpScriptToken("alpha")}`)
  await expect(app.getByText("Alpha has started.")).toBeVisible()

  await rail.getByRole("button", { name: "Bravo", exact: true }).click()
  await expect(app).toHaveURL(new RegExp(bravo.id))
  await sendPrompt(app, `Start Bravo. ${acpScriptToken("bravo")}`)
  await expect(app.getByText("Bravo streams in the foreground.")).toBeVisible()
  expect(await alphaText()).not.toContain("Alpha has finished.")

  await expect(app.getByRole("button", { name: UI.sendIdle })).toBeVisible()
  await sendPrompt(app, `Again. ${acpScriptToken("bravo-background")}`)
  await expect(app.getByText("Bravo starts the second reply.")).toBeVisible()
  await rail.getByRole("button", { name: "Alpha", exact: true }).click()
  await expect(app).toHaveURL(new RegExp(alpha.id))
  await expect(app.getByText("Alpha has started.")).toBeVisible()
  await stack.acp.release("bravo-background")
  await expect.poll(async () => assistantText(await api.messages(workspace.directory, bravo.id))).toContain("Bravo streamed in the background. It keeps streaming. It keeps")
  const firstFrame = await firstPaintedTranscript(app, bravo.id)
  await rail.getByRole("button", { name: "Bravo", exact: true }).click()
  await expect(app).toHaveURL(new RegExp(bravo.id))
  expect(await firstFrame()).toContain("Bravo streamed in the background.")
  expect(await alphaText()).not.toContain("Alpha has finished.")

  await stack.acp.release("alpha")
  await stack.acp.release("bravo-end")
  await expect.poll(alphaText).toContain("Alpha has finished.")
})
