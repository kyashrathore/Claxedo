import { describe, expect, test } from "bun:test"
import { createAgentEventRuntime } from "../../core/runtime"
import { createOpencodeCompatProjection } from "../../projections/opencode-compat"
import { codexAppServerAdapter } from "./adapter"

const trace = [
  {
    source: "codex.app-server",
    method: "item/started",
    payload: {
      threadId: "thread-parent-1",
      turnId: "turn-parent-1",
      item: {
        id: "spawn-1",
        type: "collabAgentToolCall",
        tool: "spawn_agent",
        status: "inProgress",
        senderThreadId: "thread-parent-1",
        receiverThreadIds: ["thread-child-1"],
      },
    },
  },
  {
    source: "codex.app-server",
    method: "item/completed",
    payload: {
      threadId: "thread-parent-1",
      turnId: "turn-parent-1",
      item: {
        id: "spawn-1",
        type: "collabAgentToolCall",
        tool: "spawn_agent",
        status: "completed",
        senderThreadId: "thread-parent-1",
        receiverThreadIds: ["thread-child-1"],
      },
    },
  },
  {
    source: "codex.app-server",
    method: "item/agentMessage/delta",
    payload: {
      threadId: "thread-parent-1",
      turnId: "turn-parent-1",
      itemId: "parent-message-1",
      delta: "Parent answer unchanged.",
    },
  },
] as const

describe("Codex subagent parent transcript baseline", () => {
  test("U3/U6: reproduces the recorded parent transcript byte for byte", async () => {
    const runtime = createAgentEventRuntime({
      harness: "codex-app-server",
      threadId: "thread-parent-1",
      adapter: codexAppServerAdapter(),
      clock: () => 0,
      createId: (prefix = "id") => `${prefix}-baseline`,
    })
    const projection = createOpencodeCompatProjection({
      sessionId: "session-parent-1",
      directory: "/workspace",
      assistantMessageId: "assistant-parent-1",
      clock: () => 100,
    })
    const transcript = trace.flatMap((event) =>
      runtime.ingest(event).events.flatMap((runtimeEvent) => projection.ingest(runtimeEvent))
    )
    const serialized = `${JSON.stringify(transcript, null, 2)}\n`
    const fixture = Bun.file(`${import.meta.dir}/fixtures/codex-subagent-parent-transcript.json`)

    expect(await fixture.text()).toBe(serialized)
  })
})
