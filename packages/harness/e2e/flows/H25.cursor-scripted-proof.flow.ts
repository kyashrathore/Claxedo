import assert from "node:assert/strict"
import { ClaxedoApi, assistantText } from "../harness/api"
import { startCursorRuntime } from "../harness/cursor/runtime"
import { startStack } from "../harness/stack"
import { frameType } from "../harness/stream"

export async function run() {
  const stack = await startStack({ label: "h25-cursor-proof", cursorBackends: 1 })
  try {
    const runtime = await startCursorRuntime(stack)
    try {
      stack.cursor[0].script("proof", { steps: [
        { kind: "read", path: "proof.txt", result: "scripted proof contents" },
        { kind: "text", text: "CURSOR-PROOF-ANSWER" },
      ], usage: { inputTokens: 7, outputTokens: 11 } })
      if (process.env.H25_CURSOR_REFUSE_RUN === "1") stack.cursor[0].refuseRun("proof", 503)
      await runtime.applyBackend(0)
      const api = new ClaxedoApi(runtime.url)
      const stream = await runtime.events()
      const model = { providerId: "cursor", modelId: "scripted" }
      const policySession = await api.createSession(runtime.directory, {
        harness: { id: "cursor", access: "native" }, model, title: "Cursor permission setup",
      })
      await api.setPermissionMode(runtime.directory, policySession.id, "unsandboxed")
      const session = await api.createSession(runtime.directory, {
        harness: { id: "cursor", access: "native" }, model, title: "Cursor scripted proof",
      })
      await api.prompt(runtime.directory, session.id, "CURSOR_SCRIPT:proof", { model })
      const settled = await stream.waitFor((frame) => frameType(frame) === "session.idle" || frameType(frame) === "session.error", { label: "Cursor turn settlement" })
      assert.equal(frameType(settled), "session.idle", "Cursor scripted turn failed before session.idle")
      const messages = await api.messages(runtime.directory, session.id)
      assert.match(assistantText(messages), /CURSOR-PROOF-ANSWER/)
      assert.ok(messages.some((message) => message.parts.some((part) => part.type === "tool"
        && (part.state as { status?: string })?.status === "completed"
        && JSON.stringify(part.state).includes("scripted proof contents"))), "Cursor tool result was not stored")
      assert.ok(stream.frames.some((frame) => frameType(frame) === "message.part.updated"), "Cursor emitted no live part")
      assert.equal((await api.session(runtime.directory, session.id)).id, session.id)
      assert.ok(stack.cursor[0].requests.some((request) => request.path === "/agent.v1.AgentService/RunSSE"))
      assert.deepEqual(stack.egress.attempts, [])
      console.log("H25 Cursor proof: live frames, stored text and tool, session readback, zero egress")
    } finally {
      await runtime.close()
    }
  } finally {
    await stack.close()
  }
}
