import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { ClaxedoApi, assistantText } from "../harness/api"
import { SCRIPTED_ACP_HARNESS } from "../harness/acp/connection"
import { startStack } from "../harness/stack"
import { processAlive } from "../harness/process-alive"
import { frameSessionId, frameType } from "../harness/stream"
import { waitForTitle } from "../harness/turn-observations"

export async function run() {
  const stack = await startStack({ label: "h35-intermediate" })
  try {
    const api = new ClaxedoApi(stack.url)
    const workspace = await stack.daemon.makeWorkspace("h35-intermediate")
    const stream = await stack.events(workspace.directory)
    const model = { providerId: "pi", modelId: "openai/gpt-4.1" }
    const session = await api.createSession(workspace.directory, { harness: { id: "pi", access: "native" }, model })
    stack.scripted.scriptText({ marker: "H35INTERMEDIATESOURCE", text: "H35 intermediate source fact" })
    await api.prompt(workspace.directory, session.id, "H35INTERMEDIATESOURCE", { model, title: true })
    await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === session.id, { label: "Pi source turn", timeoutMs: 60_000 })
    await waitForTitle(stream, session.id)
    assert.match(assistantText(await api.messages(workspace.directory, session.id)), /H35 intermediate source fact/)
    const first = await api.updateSessionConfig(workspace.directory, session.id, { harness: SCRIPTED_ACP_HARNESS })
    assert.equal((first.handoff as { pending?: boolean })?.pending, true)
    const pid = Number(await fs.readFile(path.join(stack.acp.scriptDir, "agent.pid"), "utf8"))
    assert.ok(processAlive(pid))
    const second = await api.updateSessionConfig(workspace.directory, session.id, { harness: { id: "codex", access: "native" } })
    assert.equal((second.handoff as { from?: { id?: string }; pending?: boolean })?.from?.id, "pi")
    assert.equal((second.handoff as { pending?: boolean })?.pending, true)
    for (let attempt = 0; attempt < 80 && processAlive(pid); attempt++) await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(processAlive(pid), false, "intermediate ACP process was not released before the target turn")
    const restored = await api.updateSessionConfig(workspace.directory, session.id, { harness: { id: "pi", access: "native" } })
    assert.deepEqual(restored.model, { providerID: "pi", modelID: "openai/gpt-4.1" })
    assert.equal(restored.handoff, undefined)
    assert.equal((await api.session(workspace.directory, session.id)).id, session.id)
    console.log("H35 intermediate: ACP was released and the original Pi binding was restored")
  } finally {
    await stack.close()
  }
}
