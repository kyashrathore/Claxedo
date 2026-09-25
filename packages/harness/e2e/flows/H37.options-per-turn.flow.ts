import assert from "node:assert/strict"
import { ClaxedoApi, assistantText } from "../harness/api"
import { SCRIPTED_ACP_HARNESS } from "../harness/acp/connection"
import { acpScriptToken } from "../harness/acp/script"
import { readAcpRequests } from "../harness/acp/requests"
import { startStack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"
import { directTransport } from "../harness/transport"
import { unexpectedEgress } from "../harness/egress-guard"

export async function run() {
  const stack = await startStack({ label: "h37-options" })
  try {
    const api = new ClaxedoApi(stack.url)
    const workspace = await stack.daemon.makeWorkspace("h37-options")
    const stream = await stack.events(workspace.directory)
    const acp = await api.createSession(workspace.directory, { harness: SCRIPTED_ACP_HARNESS })
    assert.equal((await api.sessionConfig(workspace.directory, acp.id)).model, undefined)
    await stack.acp.write("h37-options", { steps: [{ kind: "text", text: "H37 ACP options" }], capturePrompt: true })
    const url = new URL(`/session/${encodeURIComponent(acp.id)}/message`, stack.url)
    url.searchParams.set("directory", workspace.directory)
    const reply = await directTransport({ method: "POST", url: url.toString(), headers: { "content-type": "application/json" }, body: JSON.stringify({ parts: [{ type: "text", text: `H37 options ${acpScriptToken("h37-options")}` }], permissionMode: "review" }) })
    assert.equal(reply.status, 200, reply.body)
    await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === acp.id, { label: "ACP option turn", timeoutMs: 60_000 })
    const requests = await readAcpRequests(stack.acp.scriptDir)
    assert.ok(requests.some((row) => row.method === "session/set_config_option" && row.params.value === "review"), "turn permission mode never reached ACP")
    assert.ok(requests.some((row) => row.method === "session/prompt" && JSON.stringify(row.params).includes("h37-options")))
    assert.ok(requests.filter((row) => row.method === "session/new" || row.method === "session/prompt").every((row) => !("model" in row.params)), "connection ACP received an imposed model")
    assert.match(assistantText(await api.messages(workspace.directory, acp.id)), /H37 ACP options/)
    assert.equal((await api.session(workspace.directory, acp.id)).id, acp.id)
    const codex = await api.createSession(workspace.directory, { harness: { id: "codex", access: "native" }, model: { providerId: "codex", modelId: "gpt-5.5" } })
    const codexUrl = new URL(`/session/${encodeURIComponent(codex.id)}/message`, stack.url)
    codexUrl.searchParams.set("directory", workspace.directory)
    stack.scripted.scriptText({ marker: "H37CODEXOPTIONS", text: "H37 Codex options" })
    const codexReply = await directTransport({ method: "POST", url: codexUrl.toString(), headers: { "content-type": "application/json" }, body: JSON.stringify({ parts: [{ type: "text", text: "H37CODEXOPTIONS" }], variant: "low", serviceTier: "priority" }) })
    assert.equal(codexReply.status, 200, codexReply.body)
    await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === codex.id, { label: "Codex option turn", timeoutMs: 60_000 })
    const modelRequest = stack.scripted.requests.find((row) => row.dialect === "responses" && row.prompt.includes("H37CODEXOPTIONS"))
    assert.ok(modelRequest, "Codex turn never reached the scripted model")
    assert.equal((modelRequest.body as { reasoning?: { effort?: string } }).reasoning?.effort, "low")
    assert.equal((modelRequest.body as { service_tier?: string }).service_tier, "priority")
    assert.match(assistantText(await api.messages(workspace.directory, codex.id)), /H37 Codex options/)
    assert.equal((await api.session(workspace.directory, codex.id)).id, codex.id)
    await api.updateSessionConfig(workspace.directory, codex.id, { variant: "high" })
    const secondBefore = stream.frames.length
    stack.scripted.scriptText({ marker: "H37NOEFFORT", text: "H37 no effort" })
    const secondReply = await directTransport({ method: "POST", url: codexUrl.toString(), headers: { "content-type": "application/json" }, body: JSON.stringify({ parts: [{ type: "text", text: "H37NOEFFORT" }], variant: null }) })
    assert.equal(secondReply.status, 200, secondReply.body)
    await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === codex.id && stream.frames.indexOf(frame) >= secondBefore, { label: "Codex no-effort turn", timeoutMs: 60_000 })
    const noEffort = stack.scripted.requests.find((row) => row.dialect === "responses" && row.prompt.includes("H37NOEFFORT"))
    assert.ok(noEffort)
    assert.notEqual((noEffort.body as { reasoning?: { effort?: string } }).reasoning?.effort, "high", "null turn variant inherited the saved effort")
    assert.notEqual((noEffort.body as { service_tier?: string }).service_tier, "priority", "absent turn service tier inherited the previous one")
    assert.match(assistantText(await api.messages(workspace.directory, codex.id)), /H37 no effort/)
    assert.deepEqual(unexpectedEgress(stack.egress.attempts), [])
    console.log("H37 options: ACP permission mode and Codex effort/service tier reached their harnesses; ACP imposed no model")
  } finally {
    await stack.close()
  }
}
