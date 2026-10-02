import { randomUUID } from "node:crypto"
import { expect } from "@playwright/test"
import { acpScriptToken } from "../../../harness/e2e/harness/acp/script"
import { SCRIPTED_ACP_HARNESS } from "../../../harness/e2e/harness/acp/connection"
import { connectHostedWorkspace } from "../../../harness/e2e/harness/hosted-flow"
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

export async function makeCloudWorkspace(signed: SignedStack, name: string): Promise<CloudWorkspace> {
  const call = asOwner(signed)
  const created = JSON.parse((await call("POST", "/api/workspace/create", { workspaceName: name, repoName: name, repoUrl: signed.hosted.gitUrl })).body) as { workspaceId: string }
  const catalog = JSON.parse((await call("GET", "/api/workspace?host=provisioner")).body) as { workspaces: Array<{ workspace_id: string; project_id: string }> }
  const workspace = catalog.workspaces.find((row) => row.workspace_id === created.workspaceId)
  if (!workspace) throw new Error(`Created cloud workspace ${created.workspaceId} is absent from D1`)
  return { id: workspace.workspace_id, projectId: workspace.project_id }
}

export async function startCloudWorkspace(signed: SignedStack, workspace: CloudWorkspace) {
  await connectHostedWorkspace(signed.hosted, signed.owner.person, workspace.id)
}

export async function stopCloudWorkspace(signed: SignedStack, workspace: CloudWorkspace) {
  await asOwner(signed)("POST", `/api/workspace/${workspace.id}/lifecycle/stop`, {})
}

export async function cloudTurn(signed: SignedStack, workspace: CloudWorkspace, input: { title: string; script: string; reply: string }) {
  const call = asOwner(signed)
  const sessionId = `ses_${randomUUID().replaceAll("-", "")}`
  const operationId = `session_registration_${randomUUID().replaceAll("-", "")}`
  await call("POST", "/api/control/session-registrations/reserve", { operationId, sessionId, workspaceId: workspace.id, kind: "create", title: input.title })
  await runtimeCall(signed, workspace,
    "POST",
    `/session?connectionId=${SCRIPTED_ACP_HARNESS.id}`,
    { id: sessionId, title: input.title, harness: SCRIPTED_ACP_HARNESS },
    { "x-claxedo-session-registration-operation": operationId },
  )
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
