import assert from "node:assert/strict"
import path from "node:path"
import { assistantText } from "../harness/api"
import { SCRIPTED_ACP_HARNESS, scriptedAcpConnection } from "../harness/acp/connection"
import { acpScriptToken, writeAcpScript } from "../harness/acp/script"
import { hostedFetch } from "../harness/hosted-auth"
import { hostedApi, hostedOwner, hostedSession, hostedWorkspace } from "../harness/hosted-flow"
import { startHostedStack } from "../harness/hosted-stack"
import { frameSessionId, frameType, openEventStream } from "../harness/stream"

export async function run() {
  const stack = await startHostedStack("h19-hosted-acp")
  try {
    const owner = await hostedOwner(stack)
    const scriptDir = path.join(stack.root, "acp-scripts")
    await writeAcpScript(scriptDir, "h19-hosted", { steps: [{ kind: "text", text: "HOSTED_ACP_TURN" }] })
    const configured = await hostedFetch(stack, `/api/claxedo/agent-config/connections/${SCRIPTED_ACP_HARNESS.id}`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify(scriptedAcpConnection({ bunPath: process.execPath, scriptDir, red: false })),
    }, owner)
    assert.equal(configured.status, 200, `hosted ACP configuration: ${await configured.text()}`)
    const connections = await hostedFetch(stack, "/api/claxedo/agent-config/connections", {}, owner)
    assert.equal(connections.status, 200)
    const configuration = await connections.json() as { status?: string; connections?: Array<{ connectionId?: string }> }
    assert.ok(configuration.connections?.some((row) => row.connectionId === SCRIPTED_ACP_HARNESS.id),
      `C-2: hosted did not persist the scripted ACP connection: ${JSON.stringify(configuration)}`)
    const workspace = await hostedWorkspace(stack, owner, "H19 hosted ACP")
    const api = hostedApi(stack, workspace)
    const stream = await openEventStream(stack.relayUrl, workspace.directory, {
      relayWorkspaceId: workspace.id, authorization: `Bearer ${workspace.runtimeAccessToken}`,
    })
    try {
      let session: Awaited<ReturnType<typeof hostedSession>>
      try {
        session = await hostedSession(stack, owner, workspace, SCRIPTED_ACP_HARNESS)
      } catch (error) {
        if (/connection|not configured|unavailable/i.test(String(error))) {
          throw new Error(`C-4: hosted ACP connection was not usable in the sandbox: ${String(error)}`, { cause: error })
        }
        throw error
      }
      await api.prompt(workspace.directory, session.id, acpScriptToken("h19-hosted"))
      const settled = await stream.waitFor((frame) => frameSessionId(frame) === session.id &&
        (frameType(frame) === "session.idle" || frameType(frame) === "session.error"), { label: "hosted ACP settlement", timeoutMs: 60_000 })
      assert.equal(frameType(settled), "session.idle", `hosted ACP turn failed: ${JSON.stringify(settled)}`)
      assert.match(assistantText(await api.messages(workspace.directory, session.id)), /HOSTED_ACP_TURN/)
    } finally {
      stream.close()
    }
  } finally {
    console.log(`H19.hostedacp refused outbound: ${JSON.stringify(await stack.outboundAttempts())}`)
    await stack.close()
  }
}
