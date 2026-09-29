import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { ApiError, assistantText } from "../harness/api"
import { scriptedAcpConnection } from "../harness/acp/connection"
import { acpScriptToken } from "../harness/acp/script"
import { cloudApi, cloudTransport, createCloudWorkspace, waitCloudConnection } from "../harness/cloud-workspace"
import { startStack } from "../harness/stack"
import { frameType, openEventStream } from "../harness/stream"
import { waitForTitle } from "../harness/turn-observations"
import { sendJson } from "../harness/transport"

export async function run() {
  const stack = await startStack({ label: "h32-custom-acp-secret", cloud: true })
  try {
    const secret = `h32-${randomUUID()}`
    const credentialBody = await sendJson(cloudTransport(stack), "PUT", `${stack.url}/api/claxedo/credentials`, {
      provider_id: "h32-acp", kind: "api_key", source: "managed", scope: "shared", secret,
    }, "Storing H32 ACP secret")
    const credentialId = (JSON.parse(credentialBody) as { credential: { id: string } }).credential.id
    const connectionId = "h32-secret-acp"
    const descriptor = scriptedAcpConnection({ bunPath: process.execPath, scriptDir: stack.acp.scriptDir, red: false })
    await sendJson(cloudTransport(stack), "PUT", `${stack.url}/api/claxedo/agent-config/connections/${connectionId}`, {
      ...descriptor,
      connectionId,
      secretRefs: { token: credentialId },
      config: { ...descriptor.config, secretBindings: { env: { H32_AGENT_SECRET: "token" } } },
    }, "Saving H32 custom ACP connection")
    await stack.acp.write("h32-secret", { steps: [{ kind: "env-digest", name: "H32_AGENT_SECRET" }] })
    const workspace = await createCloudWorkspace(stack, "h32-secret")
    const connection = await waitCloudConnection(stack, workspace.id)
    assert.equal(connection.status, 200, `Cloud connection: ${connection.body}`)
    const api = cloudApi(stack, workspace.id)
    const stream = await openEventStream(stack.url, workspace.directory, {
      relayWorkspaceId: workspace.id,
      authorization: `Bearer ${stack.daemon.cloudToken}`,
    })
    try {
      let session: Awaited<ReturnType<typeof api.createSession>>
      try {
        session = await api.createSession(workspace.directory, { harness: { id: connectionId, access: "connection" } })
      } catch (error) {
        if (error instanceof ApiError && /not configured|connection.*not found|unknown connection/i.test(error.body)) {
          throw new Error(`C-4: custom ACP connection was absent from the cloud sandbox: ${error.body}`, { cause: error })
        }
        if (error instanceof ApiError && /unavailable|secret|credential/i.test(error.body)) {
          throw new Error(`C-10: sandbox runtime could not lease the custom ACP secret: ${error.body}`, { cause: error })
        }
        throw error
      }
      await api.prompt(workspace.directory, session.id, acpScriptToken("h32-secret"), { title: true })
      await stream.waitFor((frame) => frameType(frame) === "session.idle", { label: "custom ACP secret turn" })
      await waitForTitle(stream, session.id)
      const messages = await api.messages(workspace.directory, session.id)
      assert.match(assistantText(messages), new RegExp(createHash("sha256").update(secret).digest("hex")))
      assert.ok(stream.frames.some((frame) => frameType(frame) === "message.part.updated"), "custom ACP secret turn emitted no live text")
      assert.equal((await api.session(workspace.directory, session.id)).id, session.id)

      await sendJson(cloudTransport(stack), "PATCH", `${stack.url}/api/claxedo/credentials/${credentialId}/status`, { status: "revoked" }, "Revoking H32 ACP secret")
      await assert.rejects(api.createSession(workspace.directory, { harness: { id: connectionId, access: "connection" } }), /unavailable|secret|credential/i)
      await stream.waitFor((frame) => frameType(frame) === "session.lifecycle" && (frame.data.payload as { phase?: string }).phase === "failed",
        { label: "revoked-secret create failure" })
      assert.deepEqual(stack.egress.attempts, [])
    } finally {
      stream.close()
    }
  } finally {
    await stack.close()
  }
}
