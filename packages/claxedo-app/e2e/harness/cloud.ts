import { randomUUID } from "node:crypto"
import { readdir } from "node:fs/promises"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect } from "@playwright/test"
import { acpScriptToken } from "../../../harness/e2e/harness/acp/script"
import { SCRIPTED_ACP_HARNESS } from "../../../harness/e2e/harness/acp/connection"
import { connectHostedWorkspace, hostedRuntimeTransport } from "../../../harness/e2e/harness/hosted-flow"
import type { MessageRow } from "../../../harness/e2e/harness/api"
import type { SignedStack } from "./signed-stack"

export type CloudWorkspace = { id: string; projectId: string }

type Reply = { status: number; body: string }

function asOwner(signed: SignedStack) {
  return async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> => {
    const reply = await signed.owner.transport({
      method,
      url: `${signed.hosted.workerUrl}${path}`,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (reply.status < 200 || reply.status >= 300) throw new Error(`${method} ${path} answered ${reply.status}: ${reply.body}`)
    return reply
  }
}

async function runtimeCall(signed: SignedStack, workspace: CloudWorkspace, method: string, route: string, body?: unknown, headers: Record<string, string> = {}) {
  const url = new URL(route, signed.hosted.workerUrl)
  url.searchParams.set("directory", `workspace:${workspace.id}`)
  const reply = await signed.runtime(workspace.id)({
    method, url: url.toString(), headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (reply.status < 200 || reply.status >= 300) throw new Error(`${method} ${route} answered ${reply.status}: ${reply.body}`)
  return reply
}

async function cloudCatalog(signed: SignedStack) {
  const catalog = JSON.parse((await asOwner(signed)("GET", "/api/workspace?host=provisioner")).body) as { workspaces: Array<{ workspace_id: string; project_id: string; display_name?: string }> }
  return catalog.workspaces
}

export async function cloudWorkspaceNames(signed: SignedStack): Promise<string[]> {
  return (await cloudCatalog(signed)).flatMap((row) => (row.display_name ? [row.display_name] : []))
}

export async function cloudWorkspaces(signed: SignedStack): Promise<Array<CloudWorkspace & { name?: string }>> {
  return (await cloudCatalog(signed)).map((row) => ({ id: row.workspace_id, projectId: row.project_id, ...(row.display_name ? { name: row.display_name } : {}) }))
}

export async function makeCloudWorkspace(signed: SignedStack, name: string): Promise<CloudWorkspace> {
  const call = asOwner(signed)
  const created = JSON.parse((await call("POST", "/api/workspace/create", { workspaceName: name, repoName: name, repoUrl: signed.hosted.gitUrl })).body) as { workspaceId: string }
  const workspace = (await cloudCatalog(signed)).find((row) => row.workspace_id === created.workspaceId)
  if (!workspace) throw new Error(`Created cloud workspace ${created.workspaceId} is absent from D1`)
  return { id: workspace.workspace_id, projectId: workspace.project_id }
}

export async function startCloudWorkspace(signed: SignedStack, workspace: CloudWorkspace) {
  await connectHostedWorkspace(signed.hosted, signed.owner.person, workspace.id)
}

export async function stopCloudWorkspace(signed: SignedStack, workspace: CloudWorkspace) {
  await asOwner(signed)("POST", `/api/workspace/${workspace.id}/lifecycle/stop`, {})
}

type CloudSessionInput = {
  title: string
  harness: { id: string; access: "native" | "connection" }
  model?: { providerId: string; modelId: string }
}

export async function createCloudSession(signed: SignedStack, workspace: CloudWorkspace, input: CloudSessionInput) {
  const sessionId = `ses_${randomUUID().replaceAll("-", "")}`
  const operationId = `session_registration_${randomUUID().replaceAll("-", "")}`
  await asOwner(signed)("POST", "/api/control/session-registrations/reserve",
    { operationId, sessionId, workspaceId: workspace.id, kind: "create", title: input.title, harness: input.harness })
  const query = input.harness.access === "native" ? `nativeHarness=${input.harness.id}` : `connectionId=${input.harness.id}`
  await runtimeCall(signed, workspace,
    "POST",
    `/session?${query}`,
    {
      id: sessionId,
      title: input.title,
      harness: input.harness,
      ...(input.model ? { model: { providerID: input.model.providerId, id: input.model.modelId } } : {}),
    },
    { "x-claxedo-session-registration-operation": operationId },
  )
  return sessionId
}

export async function cloudTurn(signed: SignedStack, workspace: CloudWorkspace, input: { title: string; script: string; reply: string }) {
  const call = asOwner(signed)
  const sessionId = await createCloudSession(signed, workspace, { title: input.title, harness: SCRIPTED_ACP_HARNESS })
  await signed.local.acp.write(input.script, { steps: [{ kind: "text", text: input.reply }] })
  await runtimeCall(signed, workspace, "POST", `/session/${sessionId}/prompt_async`, { parts: [{ type: "text", text: `Answer. ${acpScriptToken(input.script)}` }] })
  await expect
    .poll(async () => JSON.parse((await runtimeCall(signed, workspace, "GET", `/session/${sessionId}/message`)).body).some((row: { info: { role: string } }) => row.info.role === "assistant"))
    .toBe(true)
  await call("POST", `/api/control/workspaces/${workspace.id}/sessions/${sessionId}/checkpoint`, { idempotencyKey: `e2e:${sessionId}`, reason: "message-checkpoint" })
  return sessionId
}

export async function storedMessages(signed: SignedStack, workspace: CloudWorkspace, sessionId: string) {
  const page = await asOwner(signed)("GET", `/api/control/sessions/${sessionId}/messages?workspaceId=${workspace.id}&limit=50`)
  return (JSON.parse(page.body) as { messages: { info: { role: string } }[] }).messages
}

export async function storeOwnerKey(signed: SignedStack, providerId: string, secret: string) {
  await asOwner(signed)("PUT", "/api/claxedo/credentials", { provider_id: providerId, kind: "api_key", source: "managed", label: providerId, secret })
}

export async function chooseOrgSandboxProvider(signed: SignedStack, driver: string, fields: Record<string, string>) {
  const call = asOwner(signed)
  await call("PUT", "/api/claxedo/credentials", { provider_id: driver, kind: "sandbox_driver", secret: JSON.stringify(fields) })
  await call("PUT", "/api/claxedo/credentials/sandbox-drivers/default", { driver })
}

export async function listedSessions(signed: SignedStack, workspace: CloudWorkspace) {
  const listed = await asOwner(signed)("GET", `/api/control/session-list?scope=workspace&workspaceId=${encodeURIComponent(workspace.id)}`)
  return (JSON.parse(listed.body) as { items: Array<{ sessionId: string; sessionHostRoot?: string }> }).items
}

export async function sessionConnection(signed: SignedStack, workspace: CloudWorkspace, sessionId: string) {
  const answer = await asOwner(signed)("POST", `/api/workspace/${encodeURIComponent(workspace.id)}/connection`, { session: { sessionId } })
  const connection = JSON.parse(answer.body) as { backing: string; hostId: string; runtimeAccessToken: string }
  const transport = hostedRuntimeTransport(signed.hosted, { id: workspace.id, runtimeAccessToken: connection.runtimeAccessToken })
  return {
    ...connection,
    call: async (method: string, route: string) => {
      const reply = await transport({ method, url: new URL(route, signed.hosted.relayUrl).toString(), headers: {} })
      if (reply.status < 200 || reply.status >= 300) throw new Error(`${method} ${route} answered ${reply.status}: ${reply.body}`)
      return reply.body ? JSON.parse(reply.body) as unknown : undefined
    },
  }
}

export async function cloudPrompt(signed: SignedStack, workspace: CloudWorkspace, sessionId: string, text: string) {
  await runtimeCall(signed, workspace, "POST", `/session/${sessionId}/prompt_async`, { parts: [{ type: "text", text }] })
}

export async function cloudMessages(signed: SignedStack, workspace: CloudWorkspace, sessionId: string): Promise<MessageRow[]> {
  return JSON.parse((await runtimeCall(signed, workspace, "GET", `/session/${sessionId}/message`)).body) as MessageRow[]
}

function terminalFrameText(data: unknown, decoder: TextDecoder) {
  if (typeof data === "string") return data
  if (!(data instanceof ArrayBuffer)) return ""
  const bytes = new Uint8Array(data)
  if (bytes[0] !== 0) return decoder.decode(bytes, { stream: true })
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(1))) as { checkpoint?: { screen?: unknown } }
  return typeof meta.checkpoint?.screen === "string" ? meta.checkpoint.screen : ""
}

export async function relayedTerminalOutput(signed: SignedStack, workspace: CloudWorkspace, terminalId: string, marker: string): Promise<string> {
  const connection = JSON.parse((await asOwner(signed)("GET", `/api/workspace/${encodeURIComponent(workspace.id)}/connection`)).body) as { runtimeAccessToken: string }
  const url = new URL(`/workspaces/${encodeURIComponent(workspace.id)}/api/wr/pty/${encodeURIComponent(terminalId)}/connect?cursor=0`, signed.hosted.relayUrl)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  const socket = new WebSocket(url, [`claxedo-rat.${connection.runtimeAccessToken}`])
  socket.binaryType = "arraybuffer"
  const decoder = new TextDecoder()
  let output = ""
  return await new Promise<string>((resolve, reject) => {
    socket.onmessage = (event) => {
      output += terminalFrameText(event.data, decoder)
      if (!output.includes(marker)) return
      socket.close()
      resolve(output)
    }
    socket.onclose = (event) => {
      if (!output.includes(marker)) reject(new Error(`The relayed terminal closed with ${event.code} before ${marker}: ${output.slice(-200)}`))
    }
  })
}

export async function deleteCloudWorkspace(signed: SignedStack, workspace: CloudWorkspace) {
  await asOwner(signed)("DELETE", `/api/workspace/${encodeURIComponent(workspace.id)}`)
}

export async function sessionHostTables(signed: SignedStack): Promise<string[]> {
  const root = path.join(signed.hosted.root, "relay", "durable-objects")
  const hosts = (await readdir(root).catch(() => [])).filter((name) => name.includes("SessionDO"))
  const files = (await Promise.all(hosts.map(async (host) => (await readdir(path.join(root, host))).filter((file) => file.endsWith(".sqlite")).map((file) => path.join(root, host, file))))).flat()
  return files.flatMap((file) => {
    const database = new DatabaseSync(file, { readOnly: true })
    try {
      return database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'").all().map((row) => `${path.basename(file)}:${String(row.name)}`)
    } finally { database.close() }
  })
}
