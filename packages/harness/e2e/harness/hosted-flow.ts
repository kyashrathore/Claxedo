import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { ClaxedoApi } from "./api"
import { hostedFetch, signInHostedPerson, type HostedPerson } from "./hosted-auth"
import { startHostedStack } from "./hosted-stack"
import type { HttpTransport } from "./transport"

type HostedStack = Awaited<ReturnType<typeof startHostedStack>>

export async function hostedOwner(stack: HostedStack) {
  const owner = await signInHostedPerson(stack, "hosted-person-a")
  const claim = await stack.provisionOwnerClaim(owner.id)
  const result = await hostedFetch(stack, "/api/claxedo/auth/bootstrap-owner", {
    method: "POST",
    headers: { "content-type": "application/json", "x-claxedo-bootstrap-owner-claim": claim },
    body: "{}",
  }, owner)
  if (!result.ok) throw new Error(`hosted owner bootstrap failed: ${result.status} ${await result.text()}`)
  return owner
}

export async function hostedWorkspace(stack: HostedStack, owner: HostedPerson, name: string) {
  const created = await hostedFetch(stack, "/api/workspace/create", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceName: name, repoUrl: stack.gitUrl }),
  }, owner)
  if (!created.ok) throw new Error(`hosted workspace create failed: ${created.status} ${await created.text()}`)
  const { workspaceId } = await created.json() as { workspaceId: string }
  let connected = false
  for (let attempt = 0; attempt < 30; attempt++) {
    const started = await hostedFetch(stack, `/api/workspace/${encodeURIComponent(workspaceId)}/connection`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }, owner)
    if (started.ok) {
      connected = true
      break
    }
    const body = await started.json() as { error?: { code?: string } }
    if (started.status !== 409 || body.error?.code !== "cloud_runtime_unavailable") {
      throw new Error(`hosted connection start failed: ${started.status} ${JSON.stringify(body)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (!connected) throw new Error(`hosted workspace ${workspaceId} never finished provisioning`)
  const targetFile = path.join(stack.root, "local-broker-targets", `${workspaceId}.json`)
  let runtimeAccessToken: string | undefined
  let connectionReadback = "none"
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await fs.access(targetFile)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    const readback = await hostedFetch(stack, `/api/workspace/${encodeURIComponent(workspaceId)}/connection`, {}, owner)
    const body = await readback.json() as { runtimeAccessToken?: string }
    connectionReadback = `${readback.status} ${JSON.stringify(body)}`
    if (readback.ok) runtimeAccessToken = body.runtimeAccessToken
    if (runtimeAccessToken) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (!runtimeAccessToken) throw new Error(`hosted workspace ${workspaceId} did not connect: ${connectionReadback}`)
  let healthStatus = 0
  for (let attempt = 0; attempt < 30; attempt++) {
    const health = await fetch(`${stack.relayUrl}/workspaces/${encodeURIComponent(workspaceId)}/api/wr/health`, {
      headers: { authorization: `Bearer ${runtimeAccessToken}` },
    })
    healthStatus = health.status
    if (health.ok) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (healthStatus !== 200) throw new Error(`hosted workspace ${workspaceId} relay health failed: ${healthStatus}`)
  return { id: workspaceId, directory: `workspace:${workspaceId}`, runtimeAccessToken }
}

export function hostedApi(stack: HostedStack, workspace: Awaited<ReturnType<typeof hostedWorkspace>>) {
  const transport: HttpTransport = async (request) => {
    const url = new URL(request.url)
    const response = await fetch(new URL(`/workspaces/${encodeURIComponent(workspace.id)}${url.pathname}${url.search}`, stack.relayUrl), {
      method: request.method,
      headers: { ...request.headers, authorization: `Bearer ${workspace.runtimeAccessToken}` },
      body: request.body,
    })
    return { status: response.status, body: await response.text() }
  }
  return new ClaxedoApi(stack.workerUrl, transport)
}

export async function hostedSession(stack: HostedStack, owner: HostedPerson, workspace: Awaited<ReturnType<typeof hostedWorkspace>>,
  harness: { id: string; access: "native" | "connection" }, model?: { providerId: string; modelId: string }) {
  const sessionId = `ses_${randomUUID()}`
  const operationId = `session_registration_${randomUUID()}`
  const reserved = await hostedFetch(stack, "/api/control/session-registrations/reserve", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ operationId, sessionId, workspaceId: workspace.id, kind: "create" }),
  }, owner)
  if (reserved.status !== 201) throw new Error(`hosted session reserve failed: ${reserved.status} ${await reserved.text()}`)
  const target = new URL(`/workspaces/${encodeURIComponent(workspace.id)}/session`, stack.relayUrl)
  target.searchParams.set("directory", workspace.directory)
  target.searchParams.set(harness.access === "native" ? "nativeHarness" : "connectionId", harness.id)
  const created = await fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${workspace.runtimeAccessToken}`,
      "x-claxedo-session-registration-operation": operationId },
    body: JSON.stringify({ id: sessionId, harness,
      ...(model ? { model: { providerID: model.providerId, id: model.modelId } } : {}) }),
  })
  if (created.status !== 201) throw new Error(`hosted session create failed: ${created.status} ${await created.text()}`)
  return await created.json() as { id: string }
}
