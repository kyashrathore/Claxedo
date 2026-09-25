import type { Page } from "@playwright/test"
import { acpScriptToken, assistantText, expect, SCRIPTED_ACP_HARNESS, scriptedAgentPids, sendPrompt, sessionRoute, test, UI, type ClaxedoApi, type Stack } from "../harness"

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

test("04 running tool: its elapsed time counts up in whole seconds while the turn holds it", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("elapsed")
  await stack.acp.write("running", {
    steps: [{ kind: "tool", tool: "other", title: "Wait for the build", status: "in_progress" }, { kind: "hold", name: "running" }],
  })
  const session = await api.createSession(workspace.directory, { title: "Running tool", harness: SCRIPTED_ACP_HARNESS })
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await sendPrompt(app, `Build it. ${acpScriptToken("running")}`)
  const elapsed = app.getByRole("main").getByText(/^\d+s$/)
  await expect(elapsed).toBeVisible()
  const seconds = async () => Number((await elapsed.innerText()).replace(/s$/, ""))
  const first = await seconds()
  await expect.poll(seconds, { timeout: 2_500 }).toBeGreaterThan(first)
  const second = await seconds()
  await expect.poll(seconds, { timeout: 2_500 }).toBeGreaterThan(second)
  expect(Number.isInteger(await seconds())).toBe(true)
  await stack.acp.release("running")
})

const HARNESS_STATUS_READ = /\/api\/claxedo\/agent-config\/harness\?/

function harnessStatusReads(app: Page) {
  const reads: string[] = []
  app.on("request", (request) => {
    if (HARNESS_STATUS_READ.test(request.url())) reads.push(request.url())
  })
  return reads
}

test("04 an agent that ignores Stop: the composer says it stopped responding until the turn ends", async ({ stack, api, app }) => {
  test.skip(stack.app !== "v2", "v1 ends the turn at Stop and gates Send as unavailable instead of showing the peek")
  test.setTimeout(60_000)
  const workspace = await stack.daemon.makeWorkspace("deaf")
  await stack.acp.write("deaf", { steps: [{ kind: "text", text: "Started and deaf to Stop" }, { kind: "hold", name: "deaf", ignoresCancel: true }] })
  const session = await api.createSession(workspace.directory, { title: "Deaf turn", harness: SCRIPTED_ACP_HARNESS })
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await sendPrompt(app, `Start. ${acpScriptToken("deaf")}`)
  await expect(app.getByText("Started and deaf to Stop")).toBeVisible()
  const reads = harnessStatusReads(app)
  await app.getByRole("button", { name: UI.stop, exact: true }).click()
  const peek = app.getByRole("status").filter({ hasText: "The agent stopped responding" })
  await expect(peek).toBeVisible({ timeout: 15_000 })
  expect(reads).toEqual([])
  const health = await api.harnessStatus(workspace.id, session.id)
  expect(health.harnessHealth).toMatchObject({ status: "degraded", reason: "harness_process_lost" })
  await stack.acp.release("deaf")
  await expect(peek).toHaveCount(0)
  expect(reads).toEqual([])
})

test("04 a killed agent: the composer names the closed connection without reading the harness again", async ({ stack, api, app }) => {
  test.skip(stack.app !== "v2", "v1 keeps showing Connected after its agent dies")
  const { workspace, session } = await openHeldSession(stack, api, app, "killed")
  const reads = harnessStatusReads(app)
  for (const pid of scriptedAgentPids(stack.daemon.port)) process.kill(pid, "SIGKILL")
  await expect(app.getByRole("status").filter({ hasText: "The agent isn't responding" })).toBeVisible()
  await expect(app.getByRole("status").filter({ hasText: "Scripted ACP disconnected" })).toBeVisible()
  expect(reads).toEqual([])
  const health = await api.harnessStatus(workspace.id, session.id)
  expect(health.connectionState).toMatchObject({ connectionId: SCRIPTED_ACP_HARNESS.id, state: "disconnected" })
})
