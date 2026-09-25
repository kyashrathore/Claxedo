import assert from "node:assert/strict"
import { ClaxedoApi, assistantText } from "../harness/api"
import { SCRIPTED_ACP_HARNESS } from "../harness/acp/connection"
import { readAcpRequests } from "../harness/acp/requests"
import { acpScriptToken } from "../harness/acp/script"
import { startStack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"
import { directTransport, sendJson } from "../harness/transport"

async function waitForHold(scriptDir: string) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const requests = await readAcpRequests(scriptDir)
    if (requests.some((request) => request.method === "session/prompt" && JSON.stringify(request.params).includes("acp-script:h21-hold"))) return
    await Bun.sleep(50)
  }
  throw new Error("H21 held turn never reached the scripted ACP agent")
}

export async function run() {
  const stack = await startStack({ label: "h21-workspace-restart" })
  try {
    const api = new ClaxedoApi(stack.url)
    const [workspaceA, workspaceB] = await Promise.all([
      stack.daemon.makeWorkspace("h21-running"), stack.daemon.makeWorkspace("h21-restarting"),
    ])
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
    assert.equal((await api.session(workspaceB.directory, sessionB.id)).id, sessionB.id)
    await api.promptAsync(workspaceA.directory, sessionA.id, acpScriptToken("h21-hold"))
    await waitForHold(stack.acp.scriptDir)
    try {
      await sendJson(directTransport, "POST", `${stack.url}/api/claxedo/agent-config/mcp/h21_change`,
        { type: "remote", url: "https://mcp.example.test/h21" }, "H21 config change")
      await assert.doesNotReject(Promise.race([
        api.promptAsync(workspaceB.directory, sessionB.id, acpScriptToken("h21-reply")),
        Bun.sleep(8_000).then(() => { throw new Error("workspace B prompt admission waited for workspace A") }),
      ]), "H-8: workspace B must admit a turn while workspace A is running")
      await streamB.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === sessionB.id && streamB.frames.filter((item) => frameType(item) === "session.idle" && frameSessionId(item) === sessionB.id).length >= 2,
        { label: "H-8: workspace B turn after ACP config restart while A is running", timeoutMs: 8_000 })
      assert.ok(streamB.frames.some((frame) => frameType(frame) === "message.part.updated" && frameSessionId(frame) === sessionB.id))
      assert.match(assistantText(await api.messages(workspaceB.directory, sessionB.id)), /H21 B continued/)
      assert.equal((await api.session(workspaceB.directory, sessionB.id)).id, sessionB.id)
      const requests = await readAcpRequests(stack.acp.scriptDir)
      assert.ok(requests.some((request) => request.method === "session/resume" && request.params.cwd === workspaceB.directory), "H-8: B did not restart its ACP connection while A ran")
      console.log("H21: workspace B restarted and completed a turn while A remained active")
    } finally {
      await stack.acp.release("h21-running")
      await streamA.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === sessionA.id, { label: "H21 A idle after release" })
    }
    assert.equal(stack.egress.attempts.length, 0)
  } finally {
    await stack.close()
  }
}
