import assert from "node:assert/strict"
import { ClaxedoApi, assistantText } from "../harness/api"
import { SCRIPTED_ACP_HARNESS } from "../harness/acp/connection"
import { acpScriptToken } from "../harness/acp/script"
import { startStack } from "../harness/stack"
import { frameType } from "../harness/stream"

export async function run() {
  const stack = await startStack({ label: "h26-acp-restoration" })
  try {
    const api = new ClaxedoApi(stack.url)
    const workspace = await stack.daemon.makeWorkspace("h26-acp-restoration")
    await stack.acp.write("h26-before", { steps: [{ kind: "text", text: "Keep the orange theme for this session" }] })
    await stack.acp.write("h26-after", { steps: [{ kind: "prompt" }, { kind: "hold", name: "h26-context-inspection" }] })
    const firstStream = await stack.events(workspace.directory)
    const session = await api.createSession(workspace.directory, { harness: SCRIPTED_ACP_HARNESS, title: "H26 ACP restoration" })
    await api.prompt(workspace.directory, session.id, `Remember the theme. ${acpScriptToken("h26-before")}`)
    await firstStream.waitFor((frame) => frameType(frame) === "session.idle", { label: "first ACP turn idle" })
    assert.match(assistantText(await api.messages(workspace.directory, session.id)), /Keep the orange theme/)
    firstStream.close()

    stack.acp.forgetSessionsOnRestart()
    await stack.daemon.restart()
    if (process.env.CLAXEDO_E2E_DROP_ACP_RECOVERY_CONTEXT === "1") stack.acp.dropRecoveryContext()
    const stream = await stack.events(workspace.directory)
    await api.promptAsync(workspace.directory, session.id, `What is the theme? ${acpScriptToken("h26-after")}`)
    await stream.waitFor((frame) => {
      if (frameType(frame) !== "message.part.updated") return false
      const part = (frame.data.payload as { properties?: { part?: { text?: string } } }).properties?.part
      return part?.text?.includes("Cache busted — agent context rebuilt from saved conversation") ?? false
    }, { label: "ACP recovery marker", timeoutMs: 60_000 }).catch(async (error: unknown) => {
      throw new Error(`${String(error)}; frames=${JSON.stringify(stream.frames.map((frame) => frameType(frame)))}; status=${JSON.stringify(await api.status(workspace.directory))}; messages=${JSON.stringify(await api.messages(workspace.directory, session.id)).slice(-1200)}; daemon=${stack.daemon.log().slice(-1200)}`)
    })
    const config = await api.sessionConfig(workspace.directory, session.id)
    const handoff = config.handoff as { pending?: boolean; transcript?: string; reason?: string } | undefined
    assert.equal(handoff?.pending, true, "handoff must be stored before the replacement turn completes")
    assert.equal(handoff.reason, "missing-session")
    assert.match(handoff.transcript ?? "", /Keep the orange theme/)
    await stack.acp.release("h26-context-inspection")
    await stream.waitFor((frame) => frameType(frame) === "session.idle", { label: "restored ACP turn idle" })
    assert.match(assistantText(await api.messages(workspace.directory, session.id)), /<session-context-recovery>[\s\S]*Keep the orange theme/)
    assert.ok(stream.frames.some((frame) => frameType(frame) === "message.part.updated"), "restored turn must stream")
    assert.equal((await api.session(workspace.directory, session.id)).id, session.id)
    assert.equal((await api.sessionConfig(workspace.directory, session.id)).handoff, undefined, "completed turn must clear handoff")
    assert.deepEqual(stack.egress.attempts, [])
    console.log("H26: missing ACP native session stored handoff before replacement, restored prior context in the next turn, and cleared it after completion")
  } finally {
    await stack.acp.release("h26-context-inspection")
    await stack.close()
  }
}
