import { startLiveTurn } from "../corpus/live"
import { taskInsertingMs } from "../corpus/tasks"
import { acpScriptToken, assistantText, expect, SCRIPTED_ACP_HARNESS, sessionRoute, test, UNTRACED } from "../harness"

test.use(UNTRACED)

const DIAGRAM = ["```mermaid", "flowchart LR", "  A[Stream frame] --> B[Delta buffer]", "  B --> C[Store commit]", "  C --> D[Markdown projection]", "  D --> E[Paint]", "```"].join("\n")

test("30 a Mermaid diagram that closes mid-stream is drawn outside the task that shows it", async ({ stack, api, app, isMobile }) => {
  test.skip(isMobile, "the task budget is measured at desktop width")
  const workspace = await stack.daemon.makeWorkspace("mermaid")
  await stack.acp.write("mermaid-first", { steps: [{ kind: "text", text: "Ready to draw." }] })
  const session = await api.createSession(workspace.directory, { title: "Mermaid", harness: SCRIPTED_ACP_HARNESS })
  await api.prompt(workspace.directory, session.id, `Get ready. ${acpScriptToken("mermaid-first")}`)
  const target = { directory: workspace.directory, sessionId: session.id }

  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await expect(app.getByText("Ready to draw.")).toBeVisible()
  const diagram = app.locator('[data-slot="mermaid-diagram"]')
  const taskMs = await taskInsertingMs(app, '[data-slot="mermaid-diagram"]', async () => {
    await startLiveTurn(stack, api, target, {
      name: "mermaid-stream",
      prompt: "Draw the pipeline.",
      steps: [{ kind: "text", text: `The pipeline:\n\n${DIAGRAM}\n\nThe diagram is drawn.`, chunks: 20, delayMs: 8 }],
    })
    await expect(diagram.locator("svg")).toBeVisible()
  })
  expect(taskMs, "the task that shows the diagram, in ms at 4x CPU throttling").toBeLessThanOrEqual(50)
  await expect(app.getByText("The diagram is drawn.")).toBeVisible()

  expect(assistantText(await api.messages(workspace.directory, session.id))).toContain("The diagram is drawn.")
})
