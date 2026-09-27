import { expectWritesAtMost, watchWrites } from "../corpus/writes"
import { releaseHold, startLiveTurn } from "../corpus/live"
import { wholeListRestyles } from "../corpus/restyle"
import { acpScriptToken, assistantText, expect, SCRIPTED_ACP_HARNESS, sessionRoute, test, UI, type Stack } from "../harness"

function sessionUrl(stack: Stack, workspaceId: string, sessionId: string): string {
  return `${stack.url}${sessionRoute(workspaceId, sessionId)}`
}

test("30 a reply streaming into a transcript taller than the screen leaves the unseen scroll thumb untouched", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("thumb")
  const earlier = Array.from({ length: 70 }, (_, index) => `Earlier line ${index + 1} keeps the transcript taller than the screen.`).join("\n\n")
  const streamed = Array.from({ length: 40 }, (_, index) => `Streamed line ${index + 1} grows the transcript.`).join("\n\n")
  await stack.acp.write("thumb-earlier", { steps: [{ kind: "text", text: earlier }] })
  const session = await api.createSession(workspace.directory, { title: "Thumb", harness: SCRIPTED_ACP_HARNESS })
  await api.prompt(workspace.directory, session.id, `Write a long answer. ${acpScriptToken("thumb-earlier")}`)
  const target = { directory: workspace.directory, sessionId: session.id }

  await app.goto(sessionUrl(stack, workspace.id, session.id))
  await expect(app.getByText("Earlier line 70 keeps", { exact: false })).toBeVisible()
  await app.mouse.move(0, 0)
  await watchWrites(app, "thumb")
  await startLiveTurn(stack, api, target, {
    name: "thumb-stream",
    prompt: "Stream another long answer.",
    steps: [{ kind: "hold", name: "thumb-stream-0" }, { kind: "text", text: `${streamed}\n\nLast streamed line.`, chunks: 40, delayMs: 8 }],
  })
  await releaseHold({ stack, api, target, app }, { hold: "thumb-stream-0", ready: "Last streamed line.", settles: true })
  await expectWritesAtMost(app, 0)

  expect(assistantText(await api.messages(workspace.directory, session.id))).toContain("Last streamed line.")
})

test("30 a reply streaming behind the collapsed floating transcript shows in full when the transcript opens", async ({ stack, api, app, isMobile }) => {
  test.skip(isMobile, "the floating composer is the maximized panel's, at desktop width")
  const workspace = await stack.daemon.makeWorkspace("floating")
  await stack.acp.write("floating-first", { steps: [{ kind: "text", text: "The first answer is short." }] })
  const session = await api.createSession(workspace.directory, { title: "Floating", harness: SCRIPTED_ACP_HARNESS })
  await api.prompt(workspace.directory, session.id, `Answer briefly. ${acpScriptToken("floating-first")}`)
  const target = { directory: workspace.directory, sessionId: session.id }
  const streamed = Array.from({ length: 30 }, (_, index) => `Hidden line ${index + 1} streams while nobody watches.`).join("\n\n")

  await app.goto(sessionUrl(stack, workspace.id, session.id))
  await expect(app.getByText("The first answer is short.")).toBeVisible()
  await app.getByRole("button", { name: UI.openPanel }).click()
  await app.getByRole("button", { name: "Maximize workspace panel" }).click()
  await startLiveTurn(stack, api, target, {
    name: "floating-stream",
    prompt: "Stream behind the panel.",
    steps: [{ kind: "hold", name: "floating-stream-0" }, { kind: "text", text: `${streamed}\n\nThe hidden reply ends here.`, chunks: 30, delayMs: 8 }],
  })
  const peek = app.getByTestId("session-transcript-peek")
  await expect(peek).toHaveAccessibleName("Collapse transcript")
  await peek.click()
  await expect(peek).toHaveAttribute("aria-expanded", "false")
  await watchWrites(app, "timeline")
  await stack.acp.release("floating-stream-0")
  await expect.poll(async () => (await api.status(workspace.directory))[session.id]?.type ?? "idle", { timeout: 30_000 }).toBe("idle")
  await expectWritesAtMost(app, 0)

  await peek.click()
  await expect(app.getByText("The hidden reply ends here.")).toBeVisible()
  expect(assistantText(await api.messages(workspace.directory, session.id))).toContain("The hidden reply ends here.")
})

test("30 scrolling a long transcript adds and removes rows without restyling the whole list", async ({ stack, api, app, isMobile }) => {
  test.skip(isMobile, "the wheel scroll is the desktop gesture")
  const workspace = await stack.daemon.makeWorkspace("scroll")
  const session = await api.createSession(workspace.directory, { title: "Scroll", harness: SCRIPTED_ACP_HARNESS })
  for (let turn = 1; turn <= 24; turn += 1) {
    await stack.acp.write(`scroll-${turn}`, { steps: [{ kind: "text", text: `Answer ${turn} has a few lines.\n\n- one\n- two\n- three\n\nEnd of answer ${turn}.` }] })
    await api.prompt(workspace.directory, session.id, `Question ${turn}. ${acpScriptToken(`scroll-${turn}`)}`)
  }

  await app.goto(sessionUrl(stack, workspace.id, session.id))
  await expect(app.getByText("End of answer 24.")).toBeVisible()
  await app.getByRole("region", { name: "scrollable content" }).hover()
  const restyles = await wholeListRestyles(app, async () => {
    for (let tick = 0; tick < 20; tick += 1) await app.mouse.wheel(0, -150)
    await expect(app.getByText("End of answer 24.")).not.toBeInViewport()
  })
  expect(restyles, "whole-list restyles while rows enter and leave").toBe(0)

  const messages = await api.messages(workspace.directory, session.id)
  expect(messages.filter((message) => message.info.role === "user")).toHaveLength(24)
})

test("30 the jump button's working dots are mounted only while it shows, and leave once it has faded out", async ({ stack, api, app, isMobile }) => {
  test.skip(isMobile, "the wheel scroll is the desktop gesture")
  const workspace = await stack.daemon.makeWorkspace("jump")
  const earlier = Array.from({ length: 70 }, (_, index) => `Earlier line ${index + 1} keeps the transcript taller than the screen.`).join("\n\n")
  await stack.acp.write("jump-earlier", { steps: [{ kind: "text", text: earlier }] })
  const session = await api.createSession(workspace.directory, { title: "Jump", harness: SCRIPTED_ACP_HARNESS })
  await api.prompt(workspace.directory, session.id, `Write a long answer. ${acpScriptToken("jump-earlier")}`)
  const target = { directory: workspace.directory, sessionId: session.id }

  await app.goto(sessionUrl(stack, workspace.id, session.id))
  await expect(app.getByText("Earlier line 70 keeps", { exact: false })).toBeVisible()
  await startLiveTurn(stack, api, target, {
    name: "jump-work",
    prompt: "Keep working.",
    steps: [{ kind: "hold", name: "jump-work-0" }, { kind: "text", text: "The held work is done." }],
  })
  await expect(app.getByRole("button", { name: UI.stop })).toBeVisible()
  const jump = app.getByRole("button", { name: "Scroll to latest message" })
  const overlay = app.locator("[data-session-timeline-jump]")
  const dotAnimations = () => overlay.evaluate((element) => element.getAnimations({ subtree: true }).filter((animation) => animation instanceof CSSAnimation).length)
  await expect.poll(dotAnimations).toBe(0)

  await app.getByRole("region", { name: "scrollable content" }).hover()
  for (let tick = 0; tick < 10; tick += 1) await app.mouse.wheel(0, -200)
  await expect(jump).toBeVisible()
  await expect.poll(dotAnimations).toBe(3)

  const removal = overlay.evaluate(
    (element) =>
      new Promise<string>((resolve) => {
        const fade = element.firstElementChild as HTMLElement
        const observer = new MutationObserver(() => {
          if (element.getAnimations({ subtree: true }).some((animation) => animation instanceof CSSAnimation)) return
          observer.disconnect()
          resolve(getComputedStyle(fade).opacity)
        })
        observer.observe(element, { subtree: true, childList: true })
      }),
  )
  await jump.click()
  expect(await removal, "the dots leave only once the button is fully transparent").toBe("0")
  expect(await dotAnimations()).toBe(0)
  await expect(app.getByRole("button", { name: UI.stop })).toBeVisible()

  await releaseHold({ stack, api, target, app }, { hold: "jump-work-0", ready: "The held work is done.", settles: true })
})
