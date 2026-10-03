import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import type { MessageRow } from "./api"
import { scriptedAcpConnection, SCRIPTED_ACP_CONNECTION_ID } from "./acp/connection"
import { writeAcpScript, type AcpScript } from "./acp/script"
import { hostedFetch, type HostedPerson } from "./hosted-auth"
import { hostedOwner, hostedControlTransport, type HostedStack } from "./hosted-flow"
import { openEventStream } from "./stream"
import { startHostedStack } from "./hosted-stack"
import { sendJson, type HttpTransport } from "./transport"

export async function configureHostedScriptedAcp(stack: HostedStack, control: HttpTransport, input: { bunPath: string; scriptDir: string; red?: boolean; core?: boolean }) {
  await sendJson(control, "PUT", `${stack.workerUrl}/api/claxedo/agent-config/connections/${SCRIPTED_ACP_CONNECTION_ID}`,
    scriptedAcpConnection({ bunPath: input.bunPath, scriptDir: input.scriptDir, red: input.red ?? false, core: input.core }), "Hosted scripted ACP setup")
  await sendJson(control, "POST", `${stack.workerUrl}/api/claxedo/agent-config/harness`,
    { harness: { kind: "native", harnessId: "pi" } }, "Hosted default harness")
}

export async function startHostedCloudStack(label: string) {
  const stack = await startHostedStack(label)
  try {
    const owner = await hostedOwner(stack)
    const control = hostedControlTransport(stack, owner)
    const scriptDir = path.join(stack.root, "acp-scripts")
    await configureHostedScriptedAcp(stack, control, { bunPath: process.execPath, scriptDir })
    return {
      ...stack, owner, control,
      acp: { scriptDir, write: (name: string, script: AcpScript) => writeAcpScript(scriptDir, name, script) },
    }
  } catch (error) {
    await stack.close()
    throw error
  }
}

export async function hostedRuntimeTarget(stack: HostedStack, workspaceId: string) {
  return JSON.parse(await fs.readFile(path.join(stack.root, "local-broker-targets", `${workspaceId}.json`), "utf8")) as {
    url: string; directory: string; home: string; pid: number; secretNames: string[]
  }
}

async function controlJson<T>(stack: HostedStack, owner: HostedPerson, route: string, body: unknown): Promise<T> {
  const response = await hostedFetch(stack, route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, owner)
  const text = await response.text()
  if (!response.ok) throw new Error(`${route} answered ${response.status}: ${text}`)
  return JSON.parse(text) as T
}

export async function hostedPiSession(stack: HostedStack, owner: HostedPerson, workspace: { id: string; directory: string }, model: { providerId: string; modelId: string }) {
  const sessionId = `ses_${randomUUID()}`
  const operationId = `session_registration_${randomUUID()}`
  await controlJson(stack, owner, "/api/control/session-registrations/reserve",
    { operationId, sessionId, workspaceId: workspace.id, kind: "create", harness: { id: "pi", access: "native" } })
  const connection = await controlJson<{ backing: string; hostId: string; runtimeAccessToken: string }>(stack, owner,
    `/api/workspace/${encodeURIComponent(workspace.id)}/connection`, { session: { sessionId } })
  const call = async <T>(method: string, route: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> => {
    const response = await fetch(new URL(`/workspaces/${encodeURIComponent(workspace.id)}${route}`, stack.relayUrl), {
      method, headers: { authorization: `Bearer ${connection.runtimeAccessToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${route} through the session host answered ${response.status}: ${text}`)
    return (text ? JSON.parse(text) : undefined) as T
  }
  return {
    sessionId, connection,
    events: () => openEventStream(stack.relayUrl, workspace.directory,
      { relayWorkspaceId: workspace.id, sessionId, authorization: `Bearer ${connection.runtimeAccessToken}` }),
    create: () => call<{ id: string }>("POST", `/session/${sessionId}?nativeHarness=pi`,
      { harness: { id: "pi", access: "native" }, model: { providerID: model.providerId, id: model.modelId } },
      { "x-claxedo-session-registration-operation": operationId }),
    prompt: (text: string) => call("POST", `/session/${sessionId}/prompt_async`,
      { parts: [{ type: "text", text }], messageID: `msg_${randomUUID()}`, model: { providerID: model.providerId, modelID: model.modelId } }),
    messages: () => call<MessageRow[]>("GET", `/session/${sessionId}/message`),
  }
}

export async function hostedSessionHostRoot(stack: HostedStack, owner: HostedPerson, workspaceId: string, sessionId: string) {
  const response = await hostedFetch(stack, `/api/control/session-list?scope=workspace&workspaceId=${encodeURIComponent(workspaceId)}`, {}, owner)
  const body = await response.json() as { items?: Array<{ sessionId?: string; sessionHostRoot?: string }> }
  return body.items?.find((item) => item.sessionId === sessionId)?.sessionHostRoot
}

export async function hostedMachineFile(stack: HostedStack, workspace: { id: string; runtimeAccessToken: string }, file: string) {
  const response = await fetch(new URL(`/workspaces/${encodeURIComponent(workspace.id)}/api/wr/file/content?path=${encodeURIComponent(file)}`, stack.relayUrl),
    { headers: { authorization: `Bearer ${workspace.runtimeAccessToken}` } })
  return { status: response.status, body: await response.json() as { content?: string } }
}
