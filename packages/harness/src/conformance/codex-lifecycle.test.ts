import { expect, test } from "bun:test"
import { setupConformance } from "./test-support/run"
import { codexBackend, makeCodexTransport, type CodexBackend } from "./test-support/codex"

const CATALOG_MODEL = { providerID: "codex", modelID: "gpt-5.5" }

test("a catalog model whose default summary is none still streams its reasoning summary, in the session and in a child", async () => {
  const context = await setupConformance({ name: "codex-reasoning-summary", backend: async () => ({ ...await codexBackend(), model: CATALOG_MODEL }),
    makeTransport: makeCodexTransport })
  try {
    const state = context.backend as CodexBackend
    const thinking: { text: string; child: boolean }[] = []
    const run = async (prompt: string) => {
      for await (const routed of context.transport.send(context.session, { ...context.turn(prompt), model: CATALOG_MODEL }, context.turnBroker())) {
        if (routed.event.type === "thinking-delta") thinking.push({ text: routed.event.delta, child: routed.route?.kind === "child" })
      }
    }
    state.server.scriptText({ marker: "PARENTREASON", text: "PARENTREASON", reasoning: "Parent weighs the reply" })
    await run("Reply with exactly this one token: PARENTREASON")
    state.server.scriptTool({ name: "spawn_agent", input: { task_name: "child_reason", message: "Reply with exactly this one token: CHILDREASON" },
      whenPromptIncludes: "DELEGATEREASON" })
    state.server.scriptText({ marker: "CHILDREASON", text: "CHILDREASON", reasoning: "Child weighs the task" })
    await run("Delegate once, then reply with exactly this one token: DELEGATEREASON")
    const summaries = state.server.requests.filter((row) => row.dialect === "responses" && !row.prompt.includes("conversation>"))
      .map((row) => (row.body as { reasoning?: { summary?: string } }).reasoning?.summary)
    expect(summaries.length).toBeGreaterThanOrEqual(3)
    expect(summaries.every((summary) => summary === "auto")).toBe(true)
    expect(thinking.filter((row) => !row.child).map((row) => row.text).join("")).toContain("Parent weighs the reply")
    expect(thinking.filter((row) => row.child).map((row) => row.text).join("")).toContain("Child weighs the task")
  } finally { await context.close() }
}, 90_000)
