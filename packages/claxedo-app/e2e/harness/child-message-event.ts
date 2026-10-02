import { expect } from "@playwright/test"
import { isRecord } from "@claxedo/helpers/guards"
import type { ClaxedoApi } from "./api"
import type { Stack } from "./stack"

export async function prepareChildMessageEvent(stack: Stack, api: ClaxedoApi) {
  const workspace = await stack.daemon.makeWorkspace("child-events")
  const childPrompt = "Send main the report CHILDREPORT with SendMessage, then reply with exactly this one token: CHILDREADY"
  stack.scripted.scriptToolSequence("CHILDEVENTPARENT", [
    { name: "Agent", input: { description: "event-reviewer", prompt: childPrompt, subagent_type: "general-purpose", run_in_background: true } },
  ])
  stack.scripted.scriptTool({ name: "SendMessage", input: { to: "main", summary: "Child report is ready for review", message: "CHILDREPORT" }, whenPromptIncludes: childPrompt, opening: true })
  const session = await api.createSession(workspace.directory, { title: "Child events", harness: { id: "claude", access: "native" }, permissionMode: "bypassPermissions" })
  return { workspace, session, prompt: "Start a background agent, then reply with exactly this one token: CHILDEVENTPARENT" }
}

export async function playChildMessageEvent(stack: Stack, api: ClaxedoApi) {
  const arranged = await prepareChildMessageEvent(stack, api)
  await api.promptAsync(arranged.workspace.directory, arranged.session.id, arranged.prompt)
  await expect.poll(async () => {
    const messages = await api.messages(arranged.workspace.directory, arranged.session.id)
    return messages.flatMap((message) => message.parts).some((part) => part.type === "notice" && isRecord(part.notice) && part.notice.kind === "agent-message")
  }, { timeout: 30_000 }).toBe(true)
  await expect.poll(async () => (await api.status(arranged.workspace.directory))[arranged.session.id]?.type ?? "idle").toBe("idle")
  return { workspace: arranged.workspace, target: { directory: arranged.workspace.directory, sessionId: arranged.session.id }, turns: 1, live: [] }
}
