import assert from "node:assert/strict"
import { ClaxedoApi, assistantText } from "../harness/api"
import { routeCursorAccount, storeCursorAccount } from "../harness/cursor/product-binding"
import { cursorBrokerDefect } from "../harness/cursor/defect-evidence"
import { unexpectedEgress } from "../harness/egress-guard"
import { startStack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"

export async function run() {
  const stack = await startStack({ label: "h1-cursor-turn", cursorBackends: 1 })
  try {
    stack.cursor[0].script("proof", { steps: [
      { kind: "read", path: "proof.txt", result: "scripted proof contents" },
      { kind: "text", text: "CURSOR-PROOF-ANSWER" },
    ], usage: { inputTokens: 7, outputTokens: 11 } })
    if (process.env.H1_CURSOR_REFUSE_RUN === "1") stack.cursor[0].refuseRun("proof", 503)
    await routeCursorAccount(stack, 0)
    await storeCursorAccount(stack)
    const workspace = await stack.daemon.makeWorkspace("h1-cursor")
    const api = new ClaxedoApi(stack.url)
    const stream = await stack.events(workspace.directory)
    const model = { providerId: "cursor", modelId: "scripted" }
    const policy = await api.createSession(workspace.directory, {
      harness: { id: "cursor", access: "native" }, model, title: "Cursor permission setup",
    })
    await api.setPermissionMode(workspace.directory, policy.id, "unsandboxed")
    const session = await api.createSession(workspace.directory, {
      harness: { id: "cursor", access: "native" }, model, title: "Cursor scripted turn",
    })
    await api.prompt(workspace.directory, session.id, "CURSOR_SCRIPT:proof", { model })
    const settled = await stream.waitFor((frame) => frameSessionId(frame) === session.id
      && (frameType(frame) === "session.idle" || frameType(frame) === "session.error"), { label: "Cursor turn settlement" })
    assert.equal(frameType(settled), "session.idle", `Cursor scripted turn failed before session.idle: ${JSON.stringify({
      settled, session: await api.session(workspace.directory, session.id),
      backendRequests: stack.cursor[0].requests.map((request) => request.path), egress: stack.egress.attempts,
      daemonLog: stack.daemon.log().slice(-2500),
    })}`)
    const messages = await api.messages(workspace.directory, session.id)
    assert.match(assistantText(messages), /CURSOR-PROOF-ANSWER/)
    assert.ok(messages.some((message) => message.parts.some((part) => part.type === "tool"
      && (part.state as { status?: string })?.status === "completed"
      && JSON.stringify(part.state).includes("scripted proof contents"))), "Cursor tool result was not stored")
    assert.ok(stream.frames.some((frame) => frameSessionId(frame) === session.id && frameType(frame) === "message.part.updated"), "Cursor emitted no live part")
    assert.equal((await api.session(workspace.directory, session.id)).id, session.id)
    assert.ok(stack.cursor[0].requests.some((request) => request.path === "/agent.v1.AgentService/RunSSE"))
    assert.deepEqual(unexpectedEgress(stack.egress.attempts), [])
    console.log(`H1 Cursor: live frames, stored text and tool, session readback; outbound attempts: ${JSON.stringify(stack.egress.attempts)}`)
  } catch (error) {
    console.error(`H1 Cursor daemon log: ${stack.daemon.log().slice(-5000)}`)
    console.error(`H1 Cursor outbound attempts: ${JSON.stringify(stack.egress.attempts)}`)
    console.error(`H1 Cursor backend requests: ${JSON.stringify(stack.cursor[0].requests.map((request) => request.path))}`)
    throw cursorBrokerDefect(stack, 0, error) ?? error
  } finally {
    await stack.close()
  }
}
