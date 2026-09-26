import { randomUUID } from "node:crypto"
import path from "node:path"
import { expect } from "@playwright/test"
import { acpScriptToken } from "./acp/script"
import { SCRIPTED_ACP_HARNESS } from "./acp/connection"
import type { SignedStack } from "./signed-stack"

const DRIVER_IMAGE = "claxedo/e2e-runtime:local"

export type CloudWorkspace = { id: string; projectId: string }

type Reply = { status: number; body: string }

function asOwner(signed: SignedStack) {
  return async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> => {
    const reply = await signed.owner.transport({
      method,
      url: `${signed.stack.url}${path}`,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (reply.status < 200 || reply.status >= 300) throw new Error(`${method} ${path} answered ${reply.status}: ${reply.body}`)
    return reply
  }
}

export async function makeCloudWorkspace(signed: SignedStack, projectName: string): Promise<CloudWorkspace> {
  const call = asOwner(signed)
  await call("PUT", "/api/workspace/drivers/docker/auth", { auth: { image: DRIVER_IMAGE }, default: true })
  const remoteDirectory = path.join(signed.stack.dataDir, "cloud-workspaces", `${projectName.toLowerCase()}-${randomUUID().slice(0, 8)}`)
  const created = JSON.parse((await call("POST", "/api/workspace/create", { workspaceName: "main", projectName, remoteDirectory })).body) as { workspaceId: string; projectId: string }
  return { id: created.workspaceId, projectId: created.projectId }
}

export async function startCloudWorkspace(signed: SignedStack, workspace: CloudWorkspace) {
  const answer = JSON.parse((await asOwner(signed)("POST", `/api/workspace/${workspace.id}/connection`, {})).body) as { status?: string }
  if (answer.status) throw new Error(`Cloud workspace ${workspace.id} answered ${answer.status} to its start`)
}

export async function stopCloudWorkspace(signed: SignedStack, workspace: CloudWorkspace) {
  await asOwner(signed)("POST", `/api/workspace/${workspace.id}/lifecycle/stop`, {})
}

export async function cloudTurn(signed: SignedStack, workspace: CloudWorkspace, input: { title: string; script: string; reply: string }) {
  const call = asOwner(signed)
  const sessionId = `ses_${randomUUID().replaceAll("-", "")}`
  const operationId = `session_registration_${randomUUID().replaceAll("-", "")}`
  await call("POST", "/api/control/session-registrations/reserve", { operationId, sessionId, workspaceId: workspace.id, kind: "create", title: input.title })
  await call(
    "POST",
    `/workspaces/${workspace.id}/session?connectionId=${SCRIPTED_ACP_HARNESS.id}`,
    { id: sessionId, title: input.title, harness: SCRIPTED_ACP_HARNESS },
    { "x-claxedo-session-registration-operation": operationId },
  )
  await signed.stack.acp.write(input.script, { steps: [{ kind: "text", text: input.reply }] })
  await call("POST", `/workspaces/${workspace.id}/session/${sessionId}/prompt_async`, { parts: [{ type: "text", text: `Answer. ${acpScriptToken(input.script)}` }] })
  await expect
    .poll(async () => JSON.parse((await call("GET", `/workspaces/${workspace.id}/session/${sessionId}/message`)).body).some((row: { info: { role: string } }) => row.info.role === "assistant"))
    .toBe(true)
  await call("POST", `/api/control/workspaces/${workspace.id}/sessions/${sessionId}/checkpoint`, { idempotencyKey: `e2e:${sessionId}`, reason: "message-checkpoint" })
  return sessionId
}

export async function storedMessages(signed: SignedStack, workspace: CloudWorkspace, sessionId: string) {
  const page = await asOwner(signed)("GET", `/api/control/sessions/${sessionId}/messages?workspaceId=${workspace.id}&limit=50`)
  return (JSON.parse(page.body) as { messages: { info: { role: string } }[] }).messages
}
