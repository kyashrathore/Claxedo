import { expect } from "@playwright/test"
import { isRecord } from "@claxedo/helpers/guards"
import type { ClaxedoApi } from "./api"
import type { Stack } from "./stack"

export const AGENT_LIKE_HUMAN_PROMPT = "This agent's report was delivered. Reply with exactly this one token: HUMANPROMPT"
export const AGENT_OPENING_OBJECTIVE = "Reply with exactly this one token: AGENTOPENINGDONE"

export async function playAgentAuthoredMessage(stack: Stack, api: ClaxedoApi) {
  const workspace = await stack.daemon.makeWorkspace("agent-author")
  const session = await api.createSession(workspace.directory, {
    title: "Agent-authored opening", harness: { id: "claude", access: "native" },
    permissionMode: "bypassPermissions",
    model: { providerId: "claude", modelId: "claude-sonnet-4-6" },
  })
  await api.prompt(workspace.directory, session.id, AGENT_LIKE_HUMAN_PROMPT)
  await api.startGoal(workspace.directory, session.id, AGENT_OPENING_OBJECTIVE)
  await expect.poll(async () => {
    const messages = await api.messages(workspace.directory, session.id)
    return messages.some(({ info }) => info.role === "user" && isRecord(info.claxedo)
      && isRecord(info.claxedo.author) && info.claxedo.author.kind === "agent")
  }, { timeout: 30_000 }).toBe(true)
  await expect.poll(async () => (await api.status(workspace.directory))[session.id]?.type ?? "idle", { timeout: 30_000 }).toBe("idle")
  return { workspace, target: { directory: workspace.directory, sessionId: session.id }, turns: 2, live: [] }
}
