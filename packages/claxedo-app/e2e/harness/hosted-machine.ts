import { createHostKeyPair, enrollmentPayload, newHostId } from "../../../claxedo-host-connector/src/host-identity"
import { createMachineSignedTransport } from "../../../claxedo-host-connector/src/machine-transport"
import { createHostConnector, type HostEndpoints } from "../../../claxedo-host-connector/src/connector"
import { hostedFetch, type HostedPerson } from "../../../harness/e2e/harness/hosted-auth"
import { hostedControlTransport, type HostedStack } from "../../../harness/e2e/harness/hosted-flow"
import { sendJson, directTransport } from "../../../harness/e2e/harness/transport"
import type { Workspace } from "../../../harness/e2e/harness/workspaces"
import type { Stack } from "./stack"

export async function startHostedMachine(hosted: HostedStack, local: Stack, owner: HostedPerson) {
  const keys = await createHostKeyPair()
  const hostId = newHostId()
  const account = hostedControlTransport(hosted, owner)
  const challenge = JSON.parse(await sendJson(account, "POST", `${hosted.workerUrl}/api/claxedo/host/enrollments/requests`, { hostId }, "Host enrollment challenge")) as { request_id: string; nonce: string }
  const { enrollment } = JSON.parse(await sendJson(account, "POST", `${hosted.workerUrl}/api/claxedo/host/enrollments`, {
    hostId, publicKey: keys.publicKey, requestId: challenge.request_id,
    signature: await keys.sign(enrollmentPayload({ hostId, requestId: challenge.request_id, nonce: challenge.nonce })), displayName: "Signed fixture machine",
  }, "Host enrollment")) as { enrollment: { enrollment_id: string } }
  const transport = createMachineSignedTransport({ controlPlaneUrl: hosted.workerUrl, keys, hostId, enrollmentId: enrollment.enrollment_id,
    fetch: (input, init) => hostedFetch(hosted, String(input), init) })
  const serving = JSON.parse(await sendJson(directTransport, "GET", `${local.url}/api/claxedo/host-serving`, undefined, "Machine session authority")) as { sessionAuthority: "local" | "managed-private" }
  const consented = new Map<string, string>()
  let endpoints: HostEndpoints = {}
  let delivery = Promise.resolve()
  const connector = createHostConnector({
    mode: "machine", transport, hostId, enrollmentId: enrollment.enrollment_id, heartbeatIntervalMs: 1_000,
    sessionAuthority: serving.sessionAuthority,
    setInterval: (fn, ms) => { const timer = setInterval(fn, ms); return { cancel: () => clearInterval(timer) } },
    onEndpoints: (value) => { endpoints = value },
    onAssignments: async (assignments) => {
      for (const assignment of assignments) {
        if (consented.get(assignment.workspaceId) !== assignment.remoteDirectory) continue
        if (connector.acked().some((ack) => ack.workspaceId === assignment.workspaceId && ack.revision === assignment.revision)) continue
        await connector.ack({ workspaceId: assignment.workspaceId, revision: assignment.revision })
      }
    },
    onServing: (credential) => {
      delivery = delivery.then(async () => {
        await sendJson(directTransport, "PUT", `${local.url}/api/claxedo/host-serving`, {
          credential: credential ?? null,
          endpoints: { relayJwksUrl: endpoints.relay?.jwksUrl, sessionAuthorityUrl: endpoints.authority?.sessionAuthorityUrl, sessionRowsUrl: endpoints.sessionRows?.url },
        }, "Delivering machine serving credential")
      })
      void delivery.catch(() => {})
    },
  })
  const started = await connector.start()
  if (started.status !== "enrolled") { connector.close(); throw new Error(`Host connector failed: ${JSON.stringify(started)}`) }
  try { await delivery } catch (error) { connector.close(); throw error }
  return {
    async makeWorkspace(name: string, projectName?: string): Promise<Workspace> {
      const workspace = await local.daemon.makeWorkspace(name, projectName)
      consented.set(workspace.id, workspace.directory)
      await sendJson(account, "POST", `${hosted.workerUrl}/api/workspace/${workspace.id}/host-assignment`, {
        hostId, displayName: name, repoName: projectName ?? name, remoteDirectory: workspace.directory, orgId: "hosted-e2e-organization",
      }, "Registering the owner's machine folder")
      const answers: string[] = []
      for (let attempt = 0; attempt < 40; attempt++) {
        await connector.beat()
        await delivery
        const response = await hostedFetch(hosted, `/api/workspace/${workspace.id}/connection`, {}, owner)
        const body = await response.text()
        if (answers.at(-1) !== `${response.status} ${body}`) answers.push(`${response.status} ${body}`)
        if (response.ok && (JSON.parse(body) as { runtimeAccessToken?: string }).runtimeAccessToken) {
          const catalog = await hostedFetch(hosted, "/api/workspace?host=machine", {}, owner)
          if (!catalog.ok) throw new Error(`Hosted machine catalog failed: ${catalog.status} ${await catalog.text()}`)
          const rows = await catalog.json() as { workspaces: Array<{ workspace_id: string; project_id: string }> }
          const row = rows.workspaces.find((row) => row.workspace_id === workspace.id)
          if (!row) throw new Error(`Registered folder ${workspace.id} is absent from D1`)
          return { ...workspace, projectId: row.project_id }
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      throw new Error(`Machine folder ${workspace.id} did not become routable; connection answers: ${answers.join(" | ")}`)
    },
    close: async () => {
      try { await connector.drain(); await delivery } finally { connector.close() }
    },
  }
}
