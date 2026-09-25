import assert from "node:assert/strict"
import { ApiError, ClaxedoApi } from "../harness/api"
import { SCRIPTED_ACP_HARNESS } from "../harness/acp/connection"
import { readPermissionReceipts } from "../harness/acp/receipts"
import { acpScriptToken } from "../harness/acp/script"
import { refusePermissionReplySave } from "../harness/refuse-permission-save"
import { startStack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"

export async function run() {
  const stack = await startStack({ label: "h3b-save-before-release" })
  let restore: (() => void) | undefined
  try {
    const { directory } = await stack.daemon.makeWorkspace("h3b-save-before-release")
    const api = new ClaxedoApi(stack.url)
    const stream = await stack.events(directory)
    const session = await api.createSession(directory, { harness: SCRIPTED_ACP_HARNESS, title: "H3b ACP" })
    await stack.acp.write("h3b-permission", { steps: [{ kind: "permission", tool: "execute", title: "Must save first" }] })
    await api.promptAsync(directory, session.id, acpScriptToken("h3b-permission"))
    const deadline = Date.now() + 30_000
    let request = (await api.permissions(directory)).find((row) => row.sessionID === session.id)
    while (!request && Date.now() < deadline) {
      await Bun.sleep(50)
      request = (await api.permissions(directory)).find((row) => row.sessionID === session.id)
    }
    assert.ok(request, "permission never became pending")
    assert.ok(stream.frames.some((frame) => frameType(frame) === "permission.asked" && frameSessionId(frame) === session.id))
    restore = await refusePermissionReplySave(stack.dataDir, session.id)
    await assert.rejects(() => api.replyPermission(directory, session.id, request.id, "once"),
      (error: unknown) => {
        if (!(error instanceof ApiError)) return false
        console.log(`H3b ACP save refusal: HTTP ${error.status}`)
        return error.status >= 500
      })
    await Bun.sleep(100)
    assert.deepEqual(await readPermissionReceipts(stack.acp.scriptDir), [],
      "ACP released the permission answer to the agent before saving the reply")
    assert.ok((await api.permissions(directory)).some((row) => row.id === request.id), "failed save lost the pending request")
    assert.equal(stream.frames.some((frame) => frameType(frame) === "permission.replied" && frameSessionId(frame) === session.id), false)
    assert.equal((await api.session(directory, session.id)).id, session.id)
    assert.deepEqual(stack.egress.attempts, [])
    console.log("H3b ACP: failed durable write kept the request pending and did not release the agent")
  } finally {
    restore?.()
    await stack.close()
  }
}
