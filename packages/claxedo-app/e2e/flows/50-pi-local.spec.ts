import fs from "node:fs/promises"
import path from "node:path"
import type { Page } from "@playwright/test"
import { APP_SCRIPTED_PROVIDER_IDS, assistantText, expect, processAlive, sendPrompt, sessionRoute, test, UI, type ClaxedoApi, type SessionHarness, type Stack } from "../harness"

const PI: SessionHarness = { id: "pi", access: "native" }

test.skip(({ isMobile }) => isMobile, "Pi's local flow runs once at desktop width")

async function openPi(stack: Stack, api: ClaxedoApi, app: Page, name: string, permissionMode?: string) {
  const workspace = await stack.daemon.makeWorkspace(name)
  const session = await api.createSession(workspace.directory, { title: name, harness: PI, ...(permissionMode ? { permissionMode } : {}) })
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  return { workspace, session }
}

function modelInputs(stack: Stack, marker: string) {
  return stack.scripted.requests.filter((request) => request.prompt.includes(marker)).map((request) => request.prompt).join("\n")
}

test("50 Pi local: a turn writes a file through Pi's write tool and shows its tool card", async ({ stack, api, app }) => {
  const { workspace, session } = await openPi(stack, api, app, "pi-write")
  stack.scripted.scriptTool({ name: "write", input: { path: "pi-note.txt", content: "written by pi\n" }, whenPromptIncludes: "PIWROTE" })
  await sendPrompt(app, "Write the note. Reply with exactly this one token: PIWROTE")
  await expect(app.getByText("PIWROTE", { exact: true })).toBeVisible()
  await expect(app.getByRole("button", { name: /^Write.*pi-note\.txt/ })).toBeVisible()
  expect(await fs.readFile(path.join(workspace.directory, "pi-note.txt"), "utf8")).toBe("written by pi\n")
  const tools = (await api.messages(workspace.directory, session.id)).flatMap((message) => message.parts).filter((part) => part.type === "tool")
  expect(tools).toMatchObject([{ tool: "write", state: { status: "completed", input: { path: "pi-note.txt" } } }])
})

for (const decision of ["Allow once", "Deny"] as const) {
  test(`50 Pi local: in ask mode a write waits for the person, and ${decision} decides it`, async ({ stack, api, app }) => {
    const { workspace, session } = await openPi(stack, api, app, `pi-ask-${decision === "Deny" ? "deny" : "allow"}`, "ask")
    const marker = decision === "Deny" ? "PIDENIED" : "PIALLOWED"
    stack.scripted.scriptTool({ name: "write", input: { path: "asked.txt", content: "approved\n" }, whenPromptIncludes: marker })
    await sendPrompt(app, `Write asked.txt. Reply with exactly this one token: ${marker}`)
    await expect(app.getByText("Permission required")).toBeVisible()
    await expect(app.getByRole("textbox", { name: UI.composer })).toHaveCount(0)
    expect((await api.permissions(workspace.directory)).filter((row) => row.sessionID === session.id)).toHaveLength(1)
    await app.getByRole("button", { name: decision, exact: true }).click()

    await expect(app.getByText(marker, { exact: true })).toBeVisible()
    await expect(app.getByText("Permission required")).toHaveCount(0)
    expect((await api.permissions(workspace.directory)).filter((row) => row.sessionID === session.id)).toHaveLength(0)
    const written = fs.readFile(path.join(workspace.directory, "asked.txt"), "utf8")
    if (decision === "Deny") {
      await expect(written).rejects.toThrow(/ENOENT/)
      expect(modelInputs(stack, marker)).toContain("The person denied this tool call")
    } else {
      expect(await written).toBe("approved\n")
    }
  })
}

test("50 Pi local: Pi's question tool asks the person and the model reads the answer", async ({ stack, api, app }) => {
  const { workspace, session } = await openPi(stack, api, app, "pi-question")
  stack.scripted.scriptTool({ name: "question", input: { question: "Which color should the button be?", options: ["Red", "Blue"] }, whenPromptIncludes: "PIANSWERED" })
  await sendPrompt(app, "Pick a color. Reply with exactly this one token: PIANSWERED")
  await expect(app.getByText("Which color should the button be?").first()).toBeVisible()
  await expect(app.getByRole("textbox", { name: UI.composer })).toHaveCount(0)
  await app.getByRole("radio", { name: /Blue/ }).click()
  await app.getByRole("button", { name: "Submit", exact: true }).click()

  await expect(app.getByText("PIANSWERED", { exact: true })).toBeVisible()
  expect((await api.questions(workspace.directory)).filter((row) => row.sessionID === session.id)).toHaveLength(0)
  expect(modelInputs(stack, "PIANSWERED")).toContain("Blue")
})

test("50 Pi local: Stop ends a running bash call and the turn, and the command's process is gone", async ({ stack, api, app }) => {
  const { workspace, session } = await openPi(stack, api, app, "pi-stop")
  const pidFile = path.join(workspace.directory, "stop.pid")
  stack.scripted.scriptTool({ name: "bash", input: { command: `echo $$ > ${pidFile}; exec sleep 120` }, whenPromptIncludes: "PISTOPPED" })
  await sendPrompt(app, "Wait. Reply with exactly this one token: PISTOPPED")
  const pid = await startedCommand(pidFile)
  await app.getByRole("button", { name: UI.stop, exact: true }).click()

  await expect(app.getByRole("button", { name: UI.sendIdle })).toBeVisible()
  await expect.poll(async () => (await api.session(workspace.directory, session.id)).lastTurn).toMatchObject({ status: "cancelled" })
  await expect.poll(() => processAlive(pid)).toBe(false)
  expect(assistantText(await api.messages(workspace.directory, session.id))).not.toContain("PISTOPPED")
})

test("50 Pi local: a daemon killed mid-tool restarts and Pi continues the interrupted turn", async ({ stack, api, app }) => {
  const { workspace, session } = await openPi(stack, api, app, "pi-resume")
  const pidFile = path.join(workspace.directory, "resume.pid")
  stack.scripted.scriptTool({ name: "bash", input: { command: `echo $$ > ${pidFile}; exec sleep 120` }, whenPromptIncludes: "PIRESUMED" })
  await sendPrompt(app, "Run it. Reply with exactly this one token: PIRESUMED")
  const command = await startedCommand(pidFile)
  const daemon = stack.daemon.pid()
  if (!daemon) throw new Error("The daemon has no running process")
  process.kill(daemon, "SIGKILL")
  await stack.daemon.restart()
  await app.reload()

  await expect(app.getByText("PIRESUMED", { exact: true })).toBeVisible()
  await expect.poll(async () => (await api.session(workspace.directory, session.id)).lastTurn).toMatchObject({ status: "completed" })
  const messages = await api.messages(workspace.directory, session.id)
  expect(messages.filter((message) => message.info.role === "user")).toHaveLength(1)
  expect(assistantText(messages)).toContain("PIRESUMED")
  expect(modelInputs(stack, "PIRESUMED")).toContain("interrupted")
  await expect.poll(() => processAlive(command)).toBe(false)
  await expect(app.getByRole("region", { name: "Session interrupted", exact: true })).toHaveCount(0)
})

test("50 Pi local: the model picker lists only the providers the owner connected", async ({ stack, api, app }) => {
  const { workspace } = await openPi(stack, api, app, "pi-picker")
  await app.getByRole("button", { name: /^Select harness and model/ }).click()
  const picker = app.getByRole("dialog", { name: "Select harness, model and effort" })
  await expect(picker.getByRole("button", { name: "GPT-4.1", exact: true })).toBeVisible()
  await expect(picker.getByRole("button", { name: "Claude Sonnet 4.5", exact: true })).toBeVisible()
  await expect(picker.getByText("Configured", { exact: true })).toHaveCount(2)
  await expect(picker.getByText("Connect provider", { exact: true })).toHaveCount(0)
  const options = await app.request.get(`${stack.url}/api/claxedo/agent-config/harness/options?nativeHarness=pi&directory=${encodeURIComponent(workspace.directory)}`)
  const models = ((await options.json()) as { options: { id: string; selectOptions?: { id: string }[] }[] }).options.find((option) => option.id === "model")?.selectOptions ?? []
  expect(new Set(models.map((model) => model.id.split("/")[0]))).toEqual(new Set(APP_SCRIPTED_PROVIDER_IDS))
})

async function startedCommand(pidFile: string) {
  const read = async () => Number(await fs.readFile(pidFile, "utf8").catch(() => "")) || 0
  await expect.poll(read, { timeout: 30_000 }).toBeGreaterThan(0)
  return read()
}
