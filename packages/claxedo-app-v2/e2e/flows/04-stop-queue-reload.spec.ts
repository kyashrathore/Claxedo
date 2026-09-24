import type { Page } from "@playwright/test"
import { acpScriptToken, assistantText, expect, SCRIPTED_ACP_HARNESS, sendPrompt, sessionRoute, test, UI, type ClaxedoApi, type Stack } from "../harness"

async function openHeldSession(stack: Stack, api: ClaxedoApi, app: Page, name: string) {
  const workspace = await stack.daemon.makeWorkspace(name)
  await stack.acp.write("held", {
    steps: [{ kind: "text", text: "Started the long task" }, { kind: "hold", name: "held" }, { kind: "text", text: "Finished the long task" }],
  })
  const session = await api.createSession(workspace.directory, { title: "Held turn", harness: SCRIPTED_ACP_HARNESS })
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await sendPrompt(app, `Start the long task. ${acpScriptToken("held")}`)
  await expect(app.getByText("Started the long task")).toBeVisible()
  return { workspace, session }
}

test.skip(({ isMobile }) => isMobile, "flow 4 runs at desktop width")

function userTexts(messages: Awaited<ReturnType<ClaxedoApi["messages"]>>) {
  return messages
    .filter((message) => message.info.role === "user")
    .flatMap((message) => message.parts.filter((part) => part.type === "text").map((part) => part.text ?? ""))
}

test("04 stop: the running turn ends and the composer can send again", async ({ stack, api, app }) => {
  const { workspace, session } = await openHeldSession(stack, api, app, "stop")
  await app.getByRole("button", { name: UI.stop, exact: true }).click()
  await expect(app.getByRole("button", { name: UI.sendIdle })).toBeVisible()
  await expect(app.getByText("Finished the long task")).toHaveCount(0)
  await expect.poll(async () => (await api.status(workspace.directory))[session.id]?.type ?? "idle").toBe("idle")
})

test("04 queued messages: a prompt sent during a turn waits, then runs after it", async ({ stack, api, app }) => {
  const { workspace, session } = await openHeldSession(stack, api, app, "queue")
  await stack.acp.write("next", { steps: [{ kind: "text", text: "The queued prompt ran" }] })
  await sendPrompt(app, `Then this. ${acpScriptToken("next")}`)
  await expect(app.getByText("Queued", { exact: true })).toBeVisible()
  await stack.acp.release("held")
  await expect(app.getByText("Finished the long task")).toBeVisible()
  await expect(app.getByText("The queued prompt ran")).toBeVisible()
  const messages = await api.messages(workspace.directory, session.id)
  expect(userTexts(messages).map((text) => text.split(".")[0])).toEqual(["Start the long task", "Then this"])
  expect(assistantText(messages)).toContain("The queued prompt ran")
})

test("04 reload mid-turn: a turn the daemon lost shows its failure after the reload", async ({ stack, api, app }) => {
  const { workspace, session } = await openHeldSession(stack, api, app, "reload")
  await stack.daemon.restart()
  await app.reload()
  await expect(app.getByText("Started the long task")).toBeVisible()
  await expect(app.getByRole("status").filter({ hasText: "The agent isn't responding" })).toBeVisible()
  await expect(app.getByRole("button", { name: "Resend last prompt" })).toBeVisible()
  await expect(app.getByText("Finished the long task")).toHaveCount(0)
  const messages = await api.messages(workspace.directory, session.id)
  const last = messages.filter((message) => message.info.role === "assistant").at(-1)
  expect(JSON.stringify(last?.info.error ?? null)).toContain("ACP connection closed")
})
