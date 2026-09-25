import { expectWritesAtMost, watchWrites } from "../corpus/writes"
import { releaseHold, startLiveTurn } from "../corpus/live"
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
  await watchWrites(app, stack.app, "thumb")
  await startLiveTurn(stack, api, target, {
    name: "thumb-stream",
    prompt: "Stream another long answer.",
    steps: [{ kind: "hold", name: "thumb-stream-0" }, { kind: "text", text: `${streamed}\n\nLast streamed line.`, chunks: 40, delayMs: 8 }],
  })
  await releaseHold({ stack, api, target, app }, { hold: "thumb-stream-0", ready: "Last streamed line.", settles: true })
  await expectWritesAtMost(app, stack.app, 0)

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
  await watchWrites(app, stack.app, "timeline")
  await stack.acp.release("floating-stream-0")
  await expect.poll(async () => (await api.status(workspace.directory))[session.id]?.type ?? "idle", { timeout: 30_000 }).toBe("idle")
  await expectWritesAtMost(app, stack.app, 0)

  await peek.click()
  await expect(app.getByText("The hidden reply ends here.")).toBeVisible()
  expect(assistantText(await api.messages(workspace.directory, session.id))).toContain("The hidden reply ends here.")
})
