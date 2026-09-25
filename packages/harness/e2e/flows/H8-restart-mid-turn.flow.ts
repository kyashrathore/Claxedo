import assert from "node:assert/strict"
import { ClaxedoApi, assistantText } from "../harness/api"
import { SCRIPTED_ACP_HARNESS } from "../harness/acp/connection"
import { acpScriptToken } from "../harness/acp/script"
import { waitForAcpHold } from "../harness/acp/hold"
import { blockProcessIdentity } from "../harness/process-identity-fault"
import { waitForTurnTarget } from "../harness/recovery-http"
import { startStack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"

export async function run() {
  const stack = await startStack({ label: "h8-restart-mid-turn" })
  try {
    const api = new ClaxedoApi(stack.url)
    const workspace = await stack.daemon.makeWorkspace("h8-acp")
    const before = await stack.events(workspace.directory)
    await stack.acp.write("h8-held", { steps: [
      { kind: "text", text: "H8 running before restart" },
      { kind: "hold", name: "h8-held" },
    ] })
    const session = await api.createSession(workspace.directory, { title: "H8 restart", harness: SCRIPTED_ACP_HARNESS })
    await api.promptAsync(workspace.directory, session.id, `H8 first ${acpScriptToken("h8-held")}`)
    await waitForTurnTarget(stack.url, workspace.directory, session.id)
    await before.waitFor((frame) => frameType(frame) === "message.part.delta" && frameSessionId(frame) === session.id, { label: "first turn live text" })
    await waitForAcpHold(stack.acp.scriptDir, "h8-held")
    const terminal = await fetch(new URL(`/workspaces/${encodeURIComponent(workspace.id)}/api/wr/pty`, stack.url), {
      method: "POST",
      headers: { "content-type": "application/json", "x-claxedo-directory": workspace.directory },
      body: JSON.stringify({ command: "/bin/cat", args: [], cwd: ".", sessionId: session.id }),
    })
    assert.equal(terminal.status, 200, await terminal.text())
    before.close()
    const fault = await blockProcessIdentity(stack.dataDir)
    await stack.daemon.killAndRestart({ pathPrefix: fault.bin })
    const recovering = await api.session(workspace.directory, session.id)
    assert.equal(recovering.status, "recovering")
    const refused = await fetch(new URL(`/session/${encodeURIComponent(session.id)}/prompt_async?directory=${encodeURIComponent(workspace.directory)}`, stack.url), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parts: [{ type: "text", text: "H8 refused during reconciliation" }] }),
    })
    assert.equal(refused.status, 503, stack.daemon.log())
    assert.match(await refused.text(), /workspace_launch_unreconciled/)

    await fault.release()
    await stack.daemon.killAndRestart()

    const after = await stack.events(workspace.directory)
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const probe = await fetch(new URL(`/session/${encodeURIComponent(session.id)}?directory=${encodeURIComponent(workspace.directory)}`, stack.url))
      if (probe.status === 200) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    await stack.acp.write("h8-after", { steps: [{ kind: "text", text: "H8 second turn completed" }] })
    await api.promptAsync(workspace.directory, session.id, `H8 second ${acpScriptToken("h8-after")}`)
    await after.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === session.id, { label: "second turn idle" })
    const stored = await api.messages(workspace.directory, session.id)
    assert.match(assistantText(stored), /H8 second turn completed/)
    assert.equal((await api.session(workspace.directory, session.id)).lastTurn?.status, "completed")
    console.log("H8: killed daemon mid-turn, read recovering and 503 launch fence, then completed next turn with live and stored evidence")
  } finally {
    await stack.acp.release("h8-held")
    await stack.close()
  }
}
