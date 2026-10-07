import { expect, test } from "bun:test"
import { join } from "node:path"
import { setupConformance } from "./test-support/run"
import { pollUntil } from "./test-support/poll"
import { allowCommandApprovals, codexEntry, makeCodexTransport, readMarker, recordingBackend, type CodexBackend } from "../../e2e/harness/codex-conformance"

test("a real Codex background shell survives a configuration replacement request", async () => {
  const recorder = recordingBackend()
  const context = await setupConformance({ name: "codex-background-config", backend: recorder.backend, makeTransport: makeCodexTransport })
  const release = allowCommandApprovals(context)
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
    expect(await readMarker(marker)).toBe("done\n")
    const deadline = { at: Date.now() + 10_000, signal: new AbortController().signal }
    const terminals = codexEntry(context.transport, context.session.binding.sessionId).terminals
    expect(await pollUntil(async () => await terminals.hasBackgroundTasks(deadline) ? undefined : true, deadline.at)).toBe(true)
    expect(await context.transport.configure(context.session, { projection })).toEqual({ state: "applied" })
    expect(recorder.frames.filter((frame) => frame.method === "initialize")).toHaveLength(2)
  } finally { release(); await context.close() }
}, 30_000)

test("a real Codex background shell survives a live model and effort change", async () => {
  const recorder = recordingBackend()
  const context = await setupConformance({ name: "codex-background-model", backend: recorder.backend, makeTransport: makeCodexTransport })
  const release = allowCommandApprovals(context)
  try {
    const state = context.backend as CodexBackend
    const marker = join(state.directory, "model-change-finished.txt")
    state.server.scriptTool({ name: "exec_command", input: { cmd: `sleep 5; echo done > ${marker}`, yield_time_ms: 1000 } })
    for await (const _event of context.transport.send(context.session, context.turn("Run the scripted command CODEXMODELJOB"), context.turnBroker())) {}
    expect(await Bun.file(marker).exists()).toBe(false)
    await context.transport.config!.setModelSettings!(context.session, { model: { providerID: "codex", modelID: "gpt-5.6-sol" }, effort: "high" })
    expect(recorder.frames.filter((frame) => frame.method === "initialize")).toHaveLength(1)
    expect(recorder.frames.some((frame) => frame.method === "turn/interrupt" || frame.method === "thread/backgroundTerminals/terminate")).toBe(false)
    const updated = await pollUntil(() => recorder.received.find((frame) => frame.method === "thread/settings/updated"
      && (frame.params?.threadSettings as { model?: string })?.model === "gpt-5.6-sol"), Date.now() + 5_000)
    expect(updated?.params?.threadSettings).toMatchObject({ model: "gpt-5.6-sol", effort: "high" })
    expect(await pollUntil(async () => await Bun.file(marker).exists() ? true : undefined, Date.now() + 10_000)).toBe(true)
    expect(await readMarker(marker)).toBe("done\n")
    expect(recorder.frames.filter((frame) => frame.method === "thread/start")).toHaveLength(1)
  } finally { release(); await context.close() }
}, 30_000)
