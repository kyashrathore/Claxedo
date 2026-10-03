import { expect, test } from "bun:test"
import type { OutsideTurnUsage, RoutedEvent } from "../contract"
import { setupConformance } from "./test-support/run"
import { pollUntil } from "./test-support/poll"
import { codexOptions, recordingBackend, type CodexBackend } from "../../e2e/harness/codex-conformance"
import { CodexAppServerTransport } from "../transports/codex-app-server"

const PROTOCOLS = {
  v2: { modelID: "gpt-6-astra", namespace: "collaboration", childOnly: "Message Type: NEW_TASK" },
  v1: { modelID: "gpt-4.1", namespace: "multi_agent_v1", childOnly: "\"text\":\"Delegated child task CODEXNATIVECHILD" },
} as const

type Received = { method?: string; params?: { threadId?: string; item?: { type?: string; agentThreadId?: string; receiverThreadIds?: string[] } } }

function childThread(received: Received[]): string | undefined {
  return received.map((frame) => frame.params?.item?.agentThreadId ?? frame.params?.item?.receiverThreadIds?.[0]).find(Boolean)
}

async function nativeContext(protocol: keyof typeof PROTOCOLS) {
  const recorder = recordingBackend()
  const model = { providerID: "codex", modelID: PROTOCOLS[protocol].modelID }
  const context = await setupConformance({ name: `codex-native-${protocol}`,
    makeTransport: (services, backend) => new CodexAppServerTransport(services, codexOptions(backend, { idleMs: 60_000 })),
    backend: async () => ({ ...await recorder.backend(), model }) })
  const metered: OutsideTurnUsage[] = []
  context.ports.meterUsage = (usage: unknown) => { metered.push(usage as OutsideTurnUsage) }
  const state = context.backend as CodexBackend
  state.server.scriptTool({ name: "spawn_agent", namespace: PROTOCOLS[protocol].namespace, whenPromptIncludes: "CODEXNATIVEPARENT",
    input: { task_name: "child_probe", message: "Delegated child task CODEXNATIVECHILD" } })
  state.server.scriptText({ marker: PROTOCOLS[protocol].childOnly, text: "CODEXNATIVECHILD-DONE" })
  const release = state.server.holdTextReplies(PROTOCOLS[protocol].childOnly)
  const parent: RoutedEvent[] = []
  for await (const routed of context.transport.send(context.session, context.turn("Delegate one child task, then reply with exactly this one token: CODEXNATIVEPARENT"),
    context.turnBroker())) parent.push(routed)
  await state.server.textGateReached(PROTOCOLS[protocol].childOnly)
  return { context, recorder, metered, parent, release, child: childThread(recorder.received as Received[])! }
}

async function childUpdate(context: Awaited<ReturnType<typeof setupConformance>>, child: string,
  status: "running" | "completed" | "interrupted", after = 0) {
  const update = await pollUntil(() => context.ports.subagents.slice(after).find((row) => row.providerId === child && row.status === status),
    Date.now() + 15_000)
  expect(update, `Codex child ${child} did not publish ${status}`).toBeDefined()
  return update!
}

const FOLLOWUPS = {
  v2: (_child: string) => ({ name: "followup_task", input: { target: "child_probe", message: "Second child task CODEXNATIVESECOND" } }),
  v1: (child: string) => ({ name: "send_input", input: { target: child, message: "Second child task CODEXNATIVESECOND" } }),
} as const

for (const protocol of ["v2", "v1"] as const) {
  test(`Codex's own ${protocol} subagent becomes a background child session that keeps streaming after its parent's turn ends`, async () => {
    const { context, recorder, metered, parent, release, child } = await nativeContext(protocol)
    try {
      expect(parent.filter((routed) => routed.route?.kind !== "child" && routed.event.type === "finish")).toHaveLength(1)
      expect(await childUpdate(context, child, "running")).toMatchObject({ status: "running", toolCallId: "call_1", toolCallRole: "spawn", mode: "background",
        providerId: child, providerKind: "codex", childSessionId: expect.any(String) })
      const projection = { ...context.start.projection, generation: "changed-plugins" }
      await expect(context.transport.configure(context.session, { projection })).rejects.toThrow("background tasks are running")
      expect(recorder.frames.filter((frame) => frame.method === "initialize")).toHaveLength(1)
      release()
      await childUpdate(context, child, "completed")
      const published = context.ports.childEvents.map((row) => row.event)
      const text = published.filter((routed) => routed.event.type === "text-delta").map((routed) => (routed.event as { delta: string }).delta).join("")
      expect(text).toContain("CODEXNATIVECHILD-DONE")
      expect(published.every((routed) => routed.route?.kind === "child" && routed.route.correlationKey === child)).toBe(true)
      expect(published.some((routed) => routed.event.type === "usage")).toBe(true)
      expect(metered.filter((usage) => usage.usage.observation?.scope?.includes(child))).toEqual([])
      expect(context.ports.subagents.at(-1)).toMatchObject({ status: "completed", providerId: child })
      expect(await context.transport.configure(context.session, { projection })).toEqual({ state: "applied" })
      expect(recorder.frames.filter((frame) => frame.method === "initialize")).toHaveLength(2)
    } finally { await context.close() }
  }, 120_000)

  test(`per-task stop interrupts Codex's own ${protocol} subagent and nothing else`, async () => {
    const { context, recorder, release, child } = await nativeContext(protocol)
    try {
      await childUpdate(context, child, "running")
      expect(await context.transport.backgroundTasks!.stop(context.session, { toolCallId: "call_1" })).toEqual({ ok: true })
      await childUpdate(context, child, "interrupted")
      expect(recorder.frames.filter((frame) => frame.method === "turn/interrupt").map((frame) => frame.params?.threadId)).toEqual([child])
      expect(context.ports.subagents.at(-1)).toMatchObject({ status: "interrupted", providerId: child })
      expect(await context.transport.backgroundTasks!.stop(context.session, { toolCallId: "call_1" })).toMatchObject({ ok: false, status: "not_found" })
    } finally {
      release()
      await context.close()
    }
  }, 120_000)

  test(`a follow-up to Codex's own finished ${protocol} subagent opens a new turn on the same child session under the follow-up call`, async () => {
    const { context, release, child } = await nativeContext(protocol)
    try {
      release()
      await childUpdate(context, child, "completed")
      const observed = context.ports.subagents.length
      const state = context.backend as CodexBackend
      const followup = FOLLOWUPS[protocol](child)
      state.server.scriptTool({ ...followup, namespace: PROTOCOLS[protocol].namespace, whenPromptIncludes: "CODEXNATIVEFOLLOWUP" })
      for await (const _routed of context.transport.send(context.session, { ...context.turn("Follow up once, then reply with exactly this one token: CODEXNATIVEFOLLOWUP", "u2"),
        turnId: "t2", assistantMessageId: "a2" }, context.turnBroker())) { void _routed }
      await childUpdate(context, child, "completed", observed)
      const updates = context.ports.subagents.filter((row) => row.providerId === child)
      const reopened = updates.findIndex((row) => row.status === "running" && row.toolCallRole === "interaction")
      expect(reopened).toBeGreaterThan(0)
      expect(updates[reopened]?.toolCallId).toMatch(/^call_/)
      expect(updates[reopened]?.toolCallId).not.toBe(updates[0]?.toolCallId)
      expect(new Set(updates.map((row) => row.childSessionId)).size).toBe(1)
      expect(updates.at(-1)?.status).toBe("completed")
    } finally { await context.close() }
  }, 120_000)
}
