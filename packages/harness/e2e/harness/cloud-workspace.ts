import { sendJson, directTransport, type HttpTransport } from "./transport"
import path from "node:path"
import fs from "node:fs/promises"
import type { Stack } from "./stack"

export type CloudWorkspace = { id: string; directory: string; status?: string }

export async function cloudRuntimeUrl(stack: Stack, workspaceId: string) {
  const file = path.join(stack.dataDir, "local-broker-targets", `${workspaceId}.json`)
  const target = JSON.parse(await fs.readFile(file, "utf8")) as { url: string; directory: string; home: string; pid: number; secretNames: string[] }
  return target
}

export function cloudSessionTransport(stack: Stack, workspaceId: string): HttpTransport {
  return (request) => {
    const url = new URL(request.url)
    const control = url.pathname.startsWith("/api/workspace/resolve") || url.pathname.startsWith("/api/control/session-registrations/")
    if (control) return cloudTransport(stack, workspaceId)(request)
    const target = new URL(`/workspaces/${encodeURIComponent(workspaceId)}${url.pathname}${url.search}`, stack.url)
    return directTransport({ ...request, url: target.toString(), headers: { ...request.headers, authorization: `Bearer ${stack.daemon.cloudToken}` } })
  }
}

export function cloudTransport(stack: Stack, workspaceId?: string): HttpTransport {
  return (request) => {
    const url = new URL(request.url)
    if (workspaceId) url.searchParams.set("workspaceId", workspaceId)
    const token = stack.daemon.cloudToken
    if (!token) throw new Error("Cloud stack has no signed token")
    return directTransport({ ...request, url: url.toString(), headers: { ...request.headers, authorization: `Bearer ${token}` } })
  }
}

export async function createCloudWorkspace(stack: Stack, name: string): Promise<CloudWorkspace> {
  const remoteDirectory = path.join(stack.dataDir, "cloud-workspaces", name)
  const body = await sendJson(cloudTransport(stack), "POST", `${stack.url}/api/workspace/create`, {
    driver: "docker",
    workspaceName: name,
    remoteDirectory,
  }, `Creating ${name} cloud workspace`)
  const workspace = JSON.parse(body) as { workspaceId?: string; directory: string; status?: string }
  if (!workspace.workspaceId) throw new Error(`Cloud create returned no workspace id: ${body}`)
  return { id: workspace.workspaceId, directory: workspace.directory, status: workspace.status }
}

export async function cloudConnection(stack: Stack, id: string) {
  const response = await fetch(`${stack.url}/api/workspace/${encodeURIComponent(id)}/connection`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${stack.daemon.cloudToken}` },
    body: "{}",
  })
  return { status: response.status, body: await response.text() }
}

export async function waitCloudConnection(stack: Stack, id: string) {
  await new Promise((resolve) => setTimeout(resolve, 8_000))
  const readback = await fetch(`${stack.url}/api/workspace/${encodeURIComponent(id)}/connection`, {
    headers: { authorization: `Bearer ${stack.daemon.cloudToken}` },
  })
  return { status: readback.status, body: await readback.text() }
}

export async function setCloudCredentialScope(stack: Stack, providerId: string, scope: "local" | "shared") {
  const authorization = `Bearer ${stack.daemon.cloudToken}`
  const listing = await fetch(`${stack.url}/api/claxedo/credentials`, { headers: { authorization } })
  if (!listing.ok) throw new Error(`Credential listing failed: ${listing.status}`)
  const body = await listing.json() as { credentials: Array<{ id: string; provider_id: string }> }
  const credential = body.credentials.find((row) => row.provider_id === providerId)
  if (!credential) throw new Error(`No scripted credential for ${providerId}`)
  const update = await fetch(`${stack.url}/api/claxedo/credentials/${encodeURIComponent(credential.id)}/scope`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization },
    body: JSON.stringify({ scope }),
  })
  if (!update.ok) throw new Error(`Cloud scope update failed: ${update.status} ${await update.text()}`)
  return credential.id
}

export async function activateCloudCredential(stack: Stack, id: string) {
  await sendJson(cloudTransport(stack), "POST", `${stack.url}/api/claxedo/credentials/activate`, { ids: [id] }, "Activating cloud credential")
}

const SIGNED_MINT_REFUSAL = /A user-principal runtime token must be minted for a signed caller/

export async function reachCloudRuntime<T>(attempt: Promise<T>): Promise<T> {
  try { return await attempt }
  catch (error) {
    if (SIGNED_MINT_REFUSAL.test(String(error))) throw new Error(`C-16: the proxy minted the signed caller no runtime token: ${String(error).slice(0, 300)}`)
    throw error
  }
}
