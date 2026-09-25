import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { ClaxedoApi, assistantText } from "../harness/api"
import { SCRIPTED_ACP_HARNESS } from "../harness/acp/connection"
import { acpScriptToken } from "../harness/acp/script"
import { startStack } from "../harness/stack"
import { processAlive } from "../harness/process-alive"
import { frameSessionId, frameType } from "../harness/stream"

export async function run() {
  const stack = await startStack({ label: "h35-delete" })
  try {
    const api = new ClaxedoApi(stack.url)
    const workspace = await stack.daemon.makeWorkspace("h35-delete")
    const stream = await stack.events(workspace.directory)
    await stack.acp.write("h35-source", { steps: [{ kind: "text", text: "H35 source kept" }] })
    const session = await api.createSession(workspace.directory, { harness: SCRIPTED_ACP_HARNESS })
    await api.prompt(workspace.directory, session.id, `H35 source ${acpScriptToken("h35-source")}`)
    await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === session.id, { label: "ACP source turn" })
    assert.match(assistantText(await api.messages(workspace.directory, session.id)), /H35 source kept/)
    const pid = Number(await fs.readFile(path.join(stack.acp.scriptDir, "agent.pid"), "utf8"))
    assert.ok(processAlive(pid), "source ACP process exited before the handoff")
    const switched = await api.updateSessionConfig(workspace.directory, session.id, { harness: { id: "pi", access: "native" } })
    assert.equal((switched.handoff as { pending?: boolean })?.pending, true)
    assert.ok(processAlive(pid), "pending handoff released its source before a turn or delete")
    await api.deleteSession(workspace.directory, session.id)
    for (let attempt = 0; attempt < 80 && processAlive(pid); attempt++) await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(processAlive(pid), false, "H-17: deleting the pending handoff did not retire the kept ACP process")
    assert.deepEqual(await api.sessions(workspace.directory), [])
    assert.ok(stream.frames.some((frame) => frameType(frame) === "session.deleted" && frameSessionId(frame) === session.id))
    console.log("H35 delete: the pending source ACP process retired after session deletion")
  } finally {
    await stack.close()
  }
}
