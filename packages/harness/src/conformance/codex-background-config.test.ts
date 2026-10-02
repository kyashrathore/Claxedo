import { expect, test } from "bun:test"
import { join } from "node:path"
import { setupConformance } from "./test-support/run"
import { pollUntil } from "./test-support/poll"
import { makeCodexTransport, recordingBackend, type CodexBackend } from "../../e2e/harness/codex-conformance"

test("a real Codex background shell survives a configuration replacement request", async () => {
  const recorder = recordingBackend()
  const context = await setupConformance({ name: "codex-background-config", backend: recorder.backend, makeTransport: makeCodexTransport })
  try {
    const state = context.backend as CodexBackend
    const marker = join(state.directory, "background-finished.txt")
    state.server.scriptTool({ name: "exec_command", input: { cmd: `sleep 5; echo done > ${marker}`, yield_time_ms: 1000 } })
    for await (const _event of context.transport.send(context.session, context.turn("Run the scripted command CODEXCONFIGJOB"), context.turnBroker())) {}
    expect(await Bun.file(marker).exists()).toBe(false)
    const projection = { ...context.start.projection, generation: "changed-plugins" }
    await expect(context.transport.configure(context.session, { projection })).rejects.toThrow("background tasks are running")
    expect(recorder.frames.filter((frame) => frame.method === "initialize")).toHaveLength(1)
    expect(recorder.frames.some((frame) => frame.method === "thread/backgroundTerminals/terminate")).toBe(false)
    expect(await pollUntil(async () => await Bun.file(marker).exists() ? true : undefined, Date.now() + 10_000)).toBe(true)
    expect(await Bun.file(marker).text()).toBe("done\n")
    expect(await context.transport.configure(context.session, { projection })).toEqual({ state: "applied" })
    expect(recorder.frames.filter((frame) => frame.method === "initialize")).toHaveLength(2)
  } finally { await context.close() }
}, 30_000)
