import { expect } from "@playwright/test"
import type { ClaxedoApi } from "./api"
import type { Stack } from "./stack"

export async function playHostChildFollowup(stack: Stack, api: ClaxedoApi) {
  const workspace = await stack.daemon.makeWorkspace("child-followup")
  const harness = { id: "claude", access: "native" as const }
  const parent = await api.createSession(workspace.directory, { title: "Child follow-up", harness, permissionMode: "bypassPermissions" })
  const child = await api.createSession(workspace.directory, { title: "Reviewer", parentId: parent.id, harness, permissionMode: "bypassPermissions" })
  for (const [index, result] of ["FIRSTCHILDRESULT", "SECONDCHILDRESULT"].entries()) {
    await api.prompt(workspace.directory, child.id, `Reply with exactly this one token: ${result}`)
    await expect.poll(async () => {
      const messages = await api.messages(workspace.directory, parent.id)
      return messages.filter((message) => message.info.role === "user").length
    }).toBe(index + 1)
    await expect.poll(async () => (await api.status(workspace.directory))[parent.id]?.type ?? "idle").toBe("idle")
  }
  const messages = await api.messages(workspace.directory, parent.id)
  const results = messages.filter((message) => message.info.role === "user").map((message) => message.parts.filter((part) => part.type === "text").map((part) => part.text).join(""))
  expect(results[0]).toContain("FIRSTCHILDRESULT")
  expect(results[1]).toContain("SECONDCHILDRESULT")
  return { workspace, target: { directory: workspace.directory, sessionId: parent.id }, turns: 2, live: [] }
}
