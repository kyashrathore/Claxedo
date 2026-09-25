import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { ClaxedoApi, assistantText } from "../harness/api"
import { SCRIPTED_ACP_HARNESS } from "../harness/acp/connection"
import { waitForAcpHold } from "../harness/acp/hold"
import { acpScriptToken } from "../harness/acp/script"
import { startStack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"

export async function run() {
  const stack = await startStack({ label: "h9-harness-process-death" })
  try {
    const api = new ClaxedoApi(stack.url)
    const workspace = await stack.daemon.makeWorkspace("h9-acp")
    const stream = await stack.events(workspace.directory)
    await stack.acp.write("h9-held", { steps: [
      { kind: "text", text: "H9 live before process death" },
      { kind: "hold", name: "h9-held" },
    ] })
    const session = await api.createSession(workspace.directory, { title: "H9 process death", harness: SCRIPTED_ACP_HARNESS })
    await api.promptAsync(workspace.directory, session.id, `H9 first ${acpScriptToken("h9-held")}`)
    await waitForAcpHold(stack.acp.scriptDir, "h9-held")
    await stream.waitFor((frame) => frameType(frame) === "message.part.delta" && frameSessionId(frame) === session.id, { label: "H9 live first turn" })
    const pid = Number(await fs.readFile(path.join(stack.acp.scriptDir, "agent.pid"), "utf8"))
    assert.ok(Number.isSafeInteger(pid) && pid > 0)
    process.kill(pid, "SIGKILL")
    await stream.waitFor((frame) => frameType(frame) === "session.error" && frameSessionId(frame) === session.id,
      { label: "H9 failed turn after process death", timeoutMs: 20_000 })
    const outcome = (await api.session(workspace.directory, session.id)).lastTurn?.status
    assert.equal(outcome, "failed", `harness death did not store a failed turn: ${stack.daemon.log()}`)
    const first = await api.messages(workspace.directory, session.id)
    assert.match(assistantText(first), /H9 live before process death/)
    assert.ok(stream.frames.some((frame) => frameSessionId(frame) === session.id && frameType(frame) === "session.status"))

    await stack.acp.write("h9-next", { steps: [{ kind: "text", text: "H9 fresh process completed" }] })
    await api.promptAsync(workspace.directory, session.id, `H9 next ${acpScriptToken("h9-next")}`)
    try {
      await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === session.id, { label: "H9 next turn idle" })
    } catch (error) {
      throw new Error(`H9 next turn did not idle: ${JSON.stringify(await api.session(workspace.directory, session.id))}; ${stack.daemon.log()}`, { cause: error })
    }
    assert.match(assistantText(await api.messages(workspace.directory, session.id)), /H9 fresh process completed/)
    assert.equal((await api.session(workspace.directory, session.id)).lastTurn?.status, "completed")
    const freshPid = Number(await fs.readFile(path.join(stack.acp.scriptDir, "agent.pid"), "utf8"))
    assert.notEqual(freshPid, pid)
    console.log("H9: killed real ACP pid, stored failed turn, then fresh pid completed next turn with live and stored evidence")
  } finally {
    await stack.acp.release("h9-held")
    await stack.close()
  }
}
