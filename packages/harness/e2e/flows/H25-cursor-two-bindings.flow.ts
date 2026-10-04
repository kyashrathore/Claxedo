import assert from "node:assert/strict"
import { ClaxedoApi, assistantText } from "../harness/api"
import { routeCursorAccount, storeCursorAccount } from "../harness/cursor/product-binding"
import { cursorBrokerDefect } from "../harness/cursor/defect-evidence"
import { unexpectedEgress } from "../harness/egress-guard"
import { startStack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"

export async function run() {
  const stack = await startStack({ label: "h25-cursor-two-bindings", cursorBackends: 2 })
  try {
    stack.cursor[0].script("first", { steps: [{ kind: "text", text: "CURSOR-FIRST-BACKEND" }] })
    stack.cursor[1].script("second", { steps: [{ kind: "text", text: "CURSOR-SECOND-BACKEND" }] })
    await routeCursorAccount(stack, 0)
    await storeCursorAccount(stack)
    const api = new ClaxedoApi(stack.url)
    const firstWorkspace = await stack.daemon.makeWorkspace("h25-cursor-first")
    const firstStream = await stack.events(firstWorkspace.directory)
    const model = { providerId: "cursor", modelId: "scripted" }
    const first = await api.createSession(firstWorkspace.directory, {
      harness: { id: "cursor", access: "native" }, model, title: "First Cursor backend", permissionMode: "unsandboxed",
    })
    await api.prompt(firstWorkspace.directory, first.id, "CURSOR_SCRIPT:first", { model })
    await firstStream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === first.id, { label: "first Cursor session idle" })
    assert.match(assistantText(await api.messages(firstWorkspace.directory, first.id)), /CURSOR-FIRST-BACKEND/)
    assert.ok(stack.cursor[0].requests.some((request) => request.path === "/agent.v1.AgentService/RunSSE"))

    await routeCursorAccount(stack, 1)
    const secondWorkspace = await stack.daemon.makeWorkspace("h25-cursor-second")
    const secondStream = await stack.events(secondWorkspace.directory)
    let second: Awaited<ReturnType<typeof api.createSession>>
    try {
      second = await api.createSession(secondWorkspace.directory, {
        harness: { id: "cursor", access: "native" }, model, title: "Second Cursor backend", permissionMode: "unsandboxed",
      })
    } catch (error) {
      assert.match(String(error), /Cursor SDK froze|CursorBackendUrlFrozenError|credential binding cannot be used/)
      assert.equal(stack.cursor[1].requests.filter((request) => request.path === "/agent.v1.AgentService/RunSSE").length,
        0, "the second agent run reached its backend despite the freeze refusal")
      assert.deepEqual(unexpectedEgress(stack.egress.attempts), [])
      console.log(`H25 outbound attempts: ${JSON.stringify(stack.egress.attempts)}`)
      throw new Error("H-19: the second Cursor session was refused because the SDK froze the first backend binding URL", { cause: error })
    }
    await api.prompt(secondWorkspace.directory, second.id, "CURSOR_SCRIPT:second", { model })
    await secondStream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === second.id, { label: "second Cursor session idle" })
    assert.match(assistantText(await api.messages(secondWorkspace.directory, second.id)), /CURSOR-SECOND-BACKEND/)
    assert.equal((await api.session(firstWorkspace.directory, first.id)).id, first.id)
    assert.equal((await api.session(secondWorkspace.directory, second.id)).id, second.id)
    assert.ok(stack.cursor[1].requests.some((request) => request.path === "/agent.v1.AgentService/RunSSE"))
    assert.deepEqual(unexpectedEgress(stack.egress.attempts), [])
    console.log(`H25 Cursor: both projected bindings reached their scripted backends; outbound attempts: ${JSON.stringify(stack.egress.attempts)}`)
  } catch (error) {
    console.error(`H25 Cursor daemon log: ${stack.daemon.log().slice(-5000)}`)
    console.error(`H25 Cursor outbound attempts: ${JSON.stringify(stack.egress.attempts)}`)
    console.error(`H25 Cursor backend requests: ${JSON.stringify(stack.cursor.map((backend) => backend.requests.map((request) => request.path)))}`)
    throw cursorBrokerDefect(stack, 0, error) ?? error
  } finally {
    await stack.close()
  }
}
