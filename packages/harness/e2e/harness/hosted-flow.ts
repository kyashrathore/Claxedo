import fs from "node:fs/promises"
import path from "node:path"
import { ClaxedoApi } from "./api"
import { hostedFetch, signInHostedPerson, type HostedPerson } from "./hosted-auth"
import { startHostedStack } from "./hosted-stack"
import type { HttpTransport } from "./transport"
import { openEventStream } from "./stream"

export type HostedStack = Awaited<ReturnType<typeof startHostedStack>>

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
  const connection = await connectHostedWorkspace(stack, owner, workspaceId)
  return { id: workspaceId, directory: `workspace:${workspaceId}`, ...connection }
}

export async function connectHostedWorkspace(stack: HostedStack, owner: HostedPerson, workspaceId: string) {
  let connected = false
  let runtimeAccessToken: string | undefined
  for (let attempt = 0; attempt < 30; attempt++) {
    const started = await hostedFetch(stack, `/api/workspace/${encodeURIComponent(workspaceId)}/connection`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }, owner)
    if (started.ok) {
      runtimeAccessToken = (await started.json() as { runtimeAccessToken?: string }).runtimeAccessToken
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
  let connectionReadback = "none"
  for (let attempt = 0; attempt < 60 && !runtimeAccessToken; attempt++) {
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
  return { runtimeAccessToken }
}

export function hostedRuntimeTransport(stack: HostedStack, workspace: { id: string; runtimeAccessToken: string }): HttpTransport {
  return async (request) => {
    const url = new URL(request.url)
    const response = await fetch(new URL(`/workspaces/${encodeURIComponent(workspace.id)}${url.pathname}${url.search}`, stack.relayUrl), {
      method: request.method,
      headers: { ...request.headers, authorization: `Bearer ${workspace.runtimeAccessToken}` },
      body: request.body,
    })
    return { status: response.status, body: await response.text() }
  }
}

export function hostedControlTransport(stack: HostedStack, owner: HostedPerson): HttpTransport {
  return async (request) => {
    const response = await hostedFetch(stack, request.url, { method: request.method, headers: request.headers, body: request.body }, owner)
    return { status: response.status, body: await response.text() }
  }
}

export function hostedApi(stack: HostedStack, workspace: Awaited<ReturnType<typeof hostedWorkspace>>, owner: HostedPerson) {
  const runtime = hostedRuntimeTransport(stack, workspace)
  const control = hostedControlTransport(stack, owner)
  return new ClaxedoApi(stack.workerUrl, (request) => {
    if (new URL(request.url).pathname.startsWith("/api/control/session-registrations/")) {
      return control(request)
    }
    return runtime(request)
  }, {
    reserveSessions: true,
    workspaceId: async (directory) => {
      if (directory !== workspace.directory) throw new Error(`Directory ${directory} does not belong to ${workspace.id}`)
      return workspace.id
    },
    events: (directory) => openEventStream(stack.relayUrl, directory, {
      relayWorkspaceId: workspace.id, authorization: `Bearer ${workspace.runtimeAccessToken}`,
    }),
  })
}
