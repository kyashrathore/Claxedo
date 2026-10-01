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

type Command = { name: string; origin: "saved" | "transport" }

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
    await stack.acp.write("h33-turn", { steps: [{ kind: "text", text: "H33_TURN" }] })
    const commandsUrl = `${stack.workerUrl}/command?directory=${encodeURIComponent(workspace.directory)}`
    const commands = JSON.parse(await sendJson(runtime, "GET", commandsUrl, undefined, "H33 cloud command list")) as Command[]
    assert.ok(commands.some((command) => command.origin === "transport"), "the running sandbox lists no transport-declared commands")
    const api = hostedApi(stack, workspace, stack.owner)
    const stream = await openEventStream(stack.relayUrl, workspace.directory, {
      relayWorkspaceId: workspace.id, authorization: `Bearer ${workspace.runtimeAccessToken}`,
    })
    try {
      const session = await api.createSession(workspace.directory, { harness: SCRIPTED_ACP_HARNESS })
      await api.prompt(workspace.directory, session.id, acpScriptToken("h33-turn"), { title: true })
      const settled = await stream.waitFor((frame) => frameSessionId(frame) === session.id &&
        (frameType(frame) === "session.idle" || frameType(frame) === "session.error"), { label: "H33 turn" })
      assert.equal(frameType(settled), "session.idle", `C-7: cloud turn after the default change failed: ${JSON.stringify(settled)}`)
      await waitForTitle(stream, session.id)
      assert.match(assistantText(await api.messages(workspace.directory, session.id)), /H33_TURN/)
      assert.ok(stream.frames.some((frame) => frameType(frame) === "message.part.updated" && frameSessionId(frame) === session.id))
      assert.equal((await api.session(workspace.directory, session.id)).id, session.id)
      const started = (await readAcpRequests(stack.acp.scriptDir)).filter((request) => request.method === "session/new").at(-1)
      assert.ok(started, "the cloud session never reached ACP session/new")
      assert.equal((await hostedRuntimeTarget(stack, workspace.id)).pid, original.pid, "config changes restarted the cloud runtime")
      assert.deepEqual(await stack.outboundAttempts(), [])
    } finally { stream.close() }
  } finally { await stack.close() }
}
