import assert from "node:assert/strict"
import { ClaxedoApi, assistantText } from "../harness/api"
import { SCRIPTED_ACP_HARNESS } from "../harness/acp/connection"
import { acpScriptToken } from "../harness/acp/script"
import { readRecovery, waitForTurnTarget } from "../harness/recovery-http"
import { startStack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"

export async function run() {
  const stack = await startStack({ label: "h22-checkpoint-drain" })
  try {
    const api = new ClaxedoApi(stack.url)
    const workspace = await stack.daemon.makeWorkspace("h22-acp")
    const stream = await stack.events(workspace.directory)
    await stack.acp.write("h22-held", { steps: [
      { kind: "text", text: "H22 held turn reached the agent" },
      { kind: "hold", name: "h22-held" },
    ] })
    const session = await api.createSession(workspace.directory, { title: "H22 checkpoint drain", harness: SCRIPTED_ACP_HARNESS })
    await api.promptAsync(workspace.directory, session.id, `H22 hold ${acpScriptToken("h22-held")}`)
    const target = await waitForTurnTarget(stack.url, workspace.directory, session.id)
    const checkpointRoute = `/workspaces/${encodeURIComponent(workspace.id)}/api/wr/checkpoint`
    const frozen = await fetch(new URL(`${checkpointRoute}/freeze`, stack.url), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ policy: "interrupt", deadlineMs: 2_000 }),
    })
    assert.equal(frozen.status, 409)
    const result = await frozen.json() as { state: string; blockers: Array<{ sessionId?: string; turnId?: string; reason: string }> }
    assert.equal(result.state, "blocked")
    const blocker = result.blockers.find((entry) => entry.sessionId === session.id && entry.turnId === target.turnId)
    assert.ok(blocker, `held turn absent from checkpoint blockers: ${JSON.stringify(result)}`)
    assert.match(blocker.reason, /^cancel_needs_action:rop_/)
    const operationId = blocker.reason.slice("cancel_needs_action:".length)
    const read = await readRecovery(stack.url, workspace.directory, session.id, operationId)
    assert.equal(read.status, 403)
    assert.equal(read.body.kind, "refused")
    if (read.body.kind === "refused") assert.equal(read.body.refusal.kind, "unauthorized")
    const detail = await fetch(new URL(checkpointRoute, stack.url))
    assert.equal(detail.status, 200)
    assert.notEqual((await detail.json() as { state: string }).state, "frozen")
    await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === session.id, { label: "checkpoint cancellation idle" })
    assert.match(assistantText(await api.messages(workspace.directory, session.id)), /H22 held turn reached the agent/)
    assert.equal((await api.session(workspace.directory, session.id)).lastTurn?.status, "completed")
    console.log("H22: interrupt drain returned 409 with cancel_needs_action operation; checkpoint stayed unfrozen; foreign operation read refused 403; frames and stored outcome passed")
  } finally {
    await stack.acp.release("h22-held")
    await stack.close()
  }
}
