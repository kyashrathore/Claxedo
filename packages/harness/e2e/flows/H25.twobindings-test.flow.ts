import assert from "node:assert/strict"
import { ClaxedoApi, assistantText } from "../harness/api"
import { startCursorRuntime } from "../harness/cursor/runtime"
import { startStack } from "../harness/stack"
import { frameType } from "../harness/stream"

export async function run() {
  const stack = await startStack({ label: "h25-two-bindings", cursorBackends: 2 })
  try {
    const runtime = await startCursorRuntime(stack)
    try {
      stack.cursor[0].script("first", { steps: [{ kind: "text", text: "CURSOR-FIRST-BACKEND" }] })
      stack.cursor[1].script("second", { steps: [{ kind: "text", text: "CURSOR-SECOND-BACKEND" }] })
      await runtime.applyBackend(0)
      const api = new ClaxedoApi(runtime.url)
      const stream = await runtime.events()
      const model = { providerId: "cursor", modelId: "scripted" }
      const policy = await api.createSession(runtime.directory, {
        harness: { id: "cursor", access: "native" }, model, title: "Cursor permission setup",
      })
      await api.setPermissionMode(runtime.directory, policy.id, "unsandboxed")
      const first = await api.createSession(runtime.directory, {
        harness: { id: "cursor", access: "native" }, model, title: "First Cursor backend",
      })
      await api.prompt(runtime.directory, first.id, "CURSOR_SCRIPT:first", { model })
      assert.match(assistantText(await api.messages(runtime.directory, first.id)), /CURSOR-FIRST-BACKEND/)
      assert.ok(stack.cursor[0].requests.some((request) => request.path === "/agent.v1.AgentService/RunSSE"))

      await runtime.applyBackend(1)
      let second: Awaited<ReturnType<typeof api.createSession>>
      try {
        second = await api.createSession(runtime.directory, {
          harness: { id: "cursor", access: "native" }, model, title: "Second Cursor backend",
        })
      } catch (error) {
        assert.match(String(error), /Cursor SDK froze|CursorBackendUrlFrozenError|credential binding cannot be used/)
        assert.equal(stack.cursor[1].requests.length, 0, "the second backend was contacted despite the freeze refusal")
        assert.deepEqual(stack.egress.attempts, [])
        throw new Error("H-25: the second Cursor session was refused because the SDK froze the first backend URL", { cause: error })
      }
      await api.prompt(runtime.directory, second.id, "CURSOR_SCRIPT:second", { model })
      await stream.waitFor((frame) => frameType(frame) === "session.idle", { label: "second Cursor session.idle" })
      assert.match(assistantText(await api.messages(runtime.directory, second.id)), /CURSOR-SECOND-BACKEND/)
      assert.equal((await api.session(runtime.directory, first.id)).id, first.id)
      assert.equal((await api.session(runtime.directory, second.id)).id, second.id)
      assert.ok(stack.cursor[1].requests.some((request) => request.path === "/agent.v1.AgentService/RunSSE"))
      assert.deepEqual(stack.egress.attempts, [])
      console.log("H25 two bindings: both Cursor sessions reached their own scripted backend")
    } finally {
      await runtime.close()
    }
  } finally {
    await stack.close()
  }
}
