import { acpScriptToken, expect, SCRIPTED_ACP_HARNESS, sendPrompt, sessionRoute, test, UI } from "../harness"

const PI = { id: "pi", access: "native" } as const

test.skip(({ isMobile }) => isMobile, "flow 5 runs at desktop width")

const MODEL_FAILURES = [
  { status: 429, marker: "RATELIMITED", message: "Rate limit reached for requests", copy: "Usage limit reached", within: 45_000 },
  { status: 401, marker: "UNAUTHORIZED", message: "Incorrect API key provided", copy: "Reconnect your AI provider", within: 15_000 },
] as const

for (const failure of MODEL_FAILURES) {
  test(`05 errors by class: a ${failure.status} from the model shows its class on the failed turn`, async ({ stack, api, app }) => {
    const workspace = await stack.daemon.makeWorkspace(`error-${failure.status}`)
    const session = await api.createSession(workspace.directory, { title: `Error ${failure.status}`, harness: PI })
    stack.scripted.scriptError({ marker: failure.marker, status: failure.status, message: failure.message })
    await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
    await sendPrompt(app, `Reply with exactly this one token: ${failure.marker}`)

    await expect(app.getByRole("status").filter({ hasText: failure.copy })).toBeVisible({ timeout: failure.within })
    await expect(app.getByRole("button", { name: UI.sendIdle })).toBeVisible()
    await expect
      .poll(async () => {
        const messages = await api.messages(workspace.directory, session.id)
        return JSON.stringify(messages.filter((message) => message.info.role === "assistant").at(-1)?.info.error ?? null)
      })
      .toContain(String(failure.status))
  })
}

test("05 errors by class: a send the server cannot receive shows the network class and keeps the draft", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("error-network")
  const session = await api.createSession(workspace.directory, { title: "Network", harness: SCRIPTED_ACP_HARNESS })
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  const prompt = app.getByRole("textbox", { name: UI.composer })
  await expect(app.getByRole("button", { name: UI.sendIdle })).toBeVisible()
  await stack.daemon.close()
  await sendPrompt(app, "This prompt never reaches the server", { waitForSend: false })

  await expect(app.getByRole("status").filter({ hasText: "Failed to send prompt" })).toBeVisible()
  await expect(prompt).toContainText("This prompt never reaches the server")
  await stack.daemon.restart()
  const messages = await api.messages(workspace.directory, session.id)
  expect(messages.filter((message) => message.info.role === "user")).toHaveLength(0)
})

test("05 a failed first turn offers its recovery, and Resend sends the prompt again", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("resend")
  await stack.acp.write("resend", { steps: [{ kind: "error", message: "Scripted first-turn failure" }] })
  const session = await api.createSession(workspace.directory, { title: "Resend", harness: SCRIPTED_ACP_HARNESS })
  const prompt = `Run the first turn. ${acpScriptToken("resend")}`
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await sendPrompt(app, prompt)

  const resend = app.getByRole("button", { name: "Resend last prompt" })
  await expect(resend).toBeVisible()
  await stack.acp.write("resend", { steps: [{ kind: "text", text: "The resent turn ran" }] })
  await resend.click()
  await expect(app.getByText("The resent turn ran")).toBeVisible()
  const sent = async () =>
    (await api.messages(workspace.directory, session.id))
      .filter((message) => message.info.role === "user")
      .flatMap((message) => message.parts.filter((part) => part.type === "text").map((part) => part.text))
  await expect.poll(sent).toEqual([prompt, prompt])
})
