import assert from "node:assert/strict"
import { assistantText } from "../harness/api"
import { SCRIPTED_ACP_HARNESS } from "../harness/acp/connection"
import { readAcpRequests } from "../harness/acp/requests"
import { acpScriptToken } from "../harness/acp/script"
import { hostedApi, hostedWorkspace, hostedRuntimeTransport } from "../harness/hosted-flow"
import { hostedFetch } from "../harness/hosted-auth"
import { hostedRuntimeTarget, startHostedCloudStack } from "../harness/hosted-cloud"
import { frameSessionId, frameType, openEventStream } from "../harness/stream"
import { waitForTitle } from "../harness/turn-observations"
import { sendJson } from "../harness/transport"

type Command = { name: string; content?: string; origin: "saved" | "transport" }

export async function run() {
  const stack = await startHostedCloudStack("h33-cloud-config")
  try {
    const workspace = await hostedWorkspace(stack, stack.owner, "h33")
    const connected = await hostedFetch(stack, `/api/workspace/${workspace.id}/connection`, {}, stack.owner)
    assert.equal(connected.status, 200, `H33 cloud connection: ${await connected.text()}`)
    const original = await hostedRuntimeTarget(stack, workspace.id)
    const control = stack.control
    const runtime = hostedRuntimeTransport(stack, workspace)
    const configUrl = `${stack.workerUrl}/api/claxedo/agent-config`
    await sendJson(control, "POST", `${configUrl}/harness`, { harness: { kind: "native", harnessId: "pi" } }, "H33 first default")
    await sendJson(control, "POST", `${configUrl}/harness`, {
      harness: { kind: "connection", connectionId: SCRIPTED_ACP_HARNESS.id },
    }, "H33 changed default")
    const health = JSON.parse(await sendJson(runtime, "GET", `${stack.workerUrl}/api/wr/health`, undefined, "H33 runtime health")) as { harness?: unknown }
    assert.deepEqual(health.harness, { kind: "connection", connectionId: SCRIPTED_ACP_HARNESS.id }, "C-7: changed default never reached the running sandbox")
    await stack.acp.write("h33-installed", { steps: [{ kind: "prompt" }] })
    const content = `Saved command delivered to cloud. ${acpScriptToken("h33-installed")}`
    await sendJson(control, "POST", `${configUrl}/commands`, { name: "cloud-proof", content }, "H33 save command")
    const commandsUrl = `${stack.workerUrl}/command?directory=${encodeURIComponent(workspace.directory)}`
    const commands = JSON.parse(await sendJson(runtime, "GET", commandsUrl, undefined, "H33 cloud command list")) as Command[]
    const saved = commands.find((command) => command.name === "cloud-proof" && command.origin === "saved")
    assert.equal(saved?.content, content, "C-7: saved command never reached the running sandbox")
    const api = hostedApi(stack, workspace, stack.owner)
    const stream = await openEventStream(stack.relayUrl, workspace.directory, {
      relayWorkspaceId: workspace.id, authorization: `Bearer ${workspace.runtimeAccessToken}`,
    })
    try {
      const session = await api.createSession(workspace.directory, { harness: SCRIPTED_ACP_HARNESS })
      await api.prompt(workspace.directory, session.id, saved.content, { title: true })
      const settled = await stream.waitFor((frame) => frameSessionId(frame) === session.id &&
        (frameType(frame) === "session.idle" || frameType(frame) === "session.error"), { label: "H33 command turn" })
      assert.equal(frameType(settled), "session.idle", `C-7: cloud command turn failed: ${JSON.stringify(settled)}`)
      await waitForTitle(stream, session.id)
      const history = assistantText(await api.messages(workspace.directory, session.id))
      assert.match(history, /Saved command delivered to cloud/)
      assert.ok(stream.frames.some((frame) => frameType(frame) === "message.part.updated" && frameSessionId(frame) === session.id))
      assert.equal((await api.session(workspace.directory, session.id)).id, session.id)
      const starts = (await readAcpRequests(stack.acp.scriptDir)).filter((request) => request.method === "session/new")
      const started = starts.at(-1)
      assert.ok(started, "saved command session never reached ACP session/new")
      await sendJson(control, "DELETE", `${configUrl}/commands/cloud-proof`, undefined, "H33 remove command")
      const removed = JSON.parse(await sendJson(runtime, "GET", commandsUrl, undefined, "H33 commands after removal")) as Command[]
      assert.ok(!removed.some((command) => command.name === "cloud-proof"), "C-7: deleted command remains in the sandbox")
      assert.ok(removed.some((command) => command.origin === "transport"), "removal dropped transport-declared commands")
      await stack.acp.write("h33-removed", { steps: [{ kind: "text", text: "H33_REMOVED" }] })
      const after = await api.createSession(workspace.directory, { harness: SCRIPTED_ACP_HARNESS })
      await api.prompt(workspace.directory, after.id, acpScriptToken("h33-removed"), { title: true })
      await stream.waitFor((frame) => frameSessionId(frame) === after.id && frameType(frame) === "session.idle", { label: "H33 removal turn" })
      await waitForTitle(stream, after.id)
      const restarted = (await readAcpRequests(stack.acp.scriptDir)).filter((request) => request.method === "session/new").at(-1)
      assert.ok(restarted, "command removal session never reached ACP session/new")
      assert.match(assistantText(await api.messages(workspace.directory, after.id)), /H33_REMOVED/)
      assert.equal((await hostedRuntimeTarget(stack, workspace.id)).pid, original.pid, "config changes restarted the cloud runtime")
      assert.deepEqual(await stack.outboundAttempts(), [])
    } finally { stream.close() }
  } finally { await stack.close() }
}
