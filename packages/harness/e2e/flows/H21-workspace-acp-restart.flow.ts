import assert from "node:assert/strict"
import { ClaxedoApi, assistantText } from "../harness/api"
import { SCRIPTED_ACP_HARNESS } from "../harness/acp/connection"
import { waitForAcpHold } from "../harness/acp/hold"
import { readAcpRequests } from "../harness/acp/requests"
import { acpScriptToken } from "../harness/acp/script"
import { eventually } from "../harness/eventually"
import { applyScriptedPluginProfile } from "../harness/scripted-plugin-profile"
import { startStack } from "../harness/stack"
import { frameSessionId, frameType, type EventStream } from "../harness/stream"

function idles(stream: EventStream, sessionId: string) {
  return stream.frames.filter((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === sessionId).length
}

async function resumed(scriptDir: string, directory: string) {
  const requests = await readAcpRequests(scriptDir)
  return requests.some((request) => request.method === "session/resume" && request.params.cwd === directory) ? true : undefined
}

export async function run() {
  const stack = await startStack({ label: "h21-workspace-restart" })
  try {
    const api = new ClaxedoApi(stack.url)
    const workspaceA = await stack.daemon.makeWorkspace("h21-running")
    const workspaceB = await stack.daemon.makeWorkspace("h21-restarting")
    await stack.acp.write("h21-hold", { steps: [{ kind: "hold", name: "h21-running" }, { kind: "text", text: "H21 A released" }] })
    await stack.acp.write("h21-reply", { steps: [{ kind: "text", text: "H21 B continued" }] })
    const streamA = await stack.events(workspaceA.directory)
    const streamB = await stack.events(workspaceB.directory)
    const sessionA = await api.createSession(workspaceA.directory, { harness: SCRIPTED_ACP_HARNESS })
    const sessionB = await api.createSession(workspaceB.directory, { harness: SCRIPTED_ACP_HARNESS })
    await api.prompt(workspaceB.directory, sessionB.id, acpScriptToken("h21-reply"))
    await streamB.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === sessionB.id, { label: "H21 initial B idle" })
    assert.ok(streamB.frames.some((frame) => frameType(frame) === "message.part.updated" && frameSessionId(frame) === sessionB.id))
    assert.match(assistantText(await api.messages(workspaceB.directory, sessionB.id)), /H21 B continued/)
    await api.promptAsync(workspaceA.directory, sessionA.id, acpScriptToken("h21-hold"))
    await waitForAcpHold(stack.acp.scriptDir, "h21-running")
    const change = applyScriptedPluginProfile(stack.url, {
      harnessIds: ["acp"],
      servers: { h21_change: { type: "streamable-http", url: "https://mcp.example.test/h21" } },
    })
    try {
      try {
        await eventually("workspace B's ACP session/resume", () => resumed(stack.acp.scriptDir, workspaceB.directory), 8_000)
      } catch (error) {
        throw new Error(`H-8: workspace B did not restart its ACP connection while workspace A's turn ran: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
      }
      assert.equal(idles(streamA, sessionA.id), 0, "H-8: workspace A's turn ended before B restarted")
      assert.equal(await resumed(stack.acp.scriptDir, workspaceA.directory), undefined, "workspace A restarted during its own turn")
      const since = streamB.frames.length
      await api.promptAsync(workspaceB.directory, sessionB.id, acpScriptToken("h21-reply"))
      await streamB.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === sessionB.id
        && streamB.frames.indexOf(frame) >= since,
        { label: "H-8: workspace B turn after its ACP config restart while A is running", timeoutMs: 8_000 })
      assert.equal(countReplies(assistantText(await api.messages(workspaceB.directory, sessionB.id))), 2)
      assert.equal((await api.session(workspaceB.directory, sessionB.id)).lastTurn?.status, "completed")
      assert.equal(idles(streamA, sessionA.id), 0, "H-8: workspace A's turn ended before B's turn completed")
      console.log("H21: workspace B restarted and completed a turn while A remained active")
    } finally {
      await stack.acp.release("h21-running")
      await streamA.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === sessionA.id, { label: "H21 A idle after release" })
      assert.equal((await change).active, true)
    }
    await eventually("workspace A's deferred ACP session/resume", () => resumed(stack.acp.scriptDir, workspaceA.directory))
    assert.match(assistantText(await api.messages(workspaceA.directory, sessionA.id)), /H21 A released/)
    assert.equal(stack.egress.attempts.length, 0)
  } finally {
    await stack.close()
  }
}

function countReplies(text: string) {
  return text.split("H21 B continued").length - 1
}
