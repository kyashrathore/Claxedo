import { expect, SCRIPTED_ACP_HARNESS, test } from "../harness"

const PI = { id: "pi", access: "native" } as const

test.skip(({ isMobile }) => isMobile, "flow 5 runs at desktop width")

const MODEL_FAILURES = [
  { status: 429, marker: "RATELIMITED", message: "Rate limit reached for requests", copy: /rate limit/i },
  { status: 401, marker: "UNAUTHORIZED", message: "Incorrect API key provided", copy: /sign in|api key|auth/i },
] as const

for (const failure of MODEL_FAILURES) {
  test(`05 errors by class: a ${failure.status} from the model shows its class on the failed turn`, async ({ stack, api, app }) => {
    const workspace = await stack.daemon.makeWorkspace(`error-${failure.status}`)
    const session = await api.createSession(workspace.directory, { title: `Error ${failure.status}`, harness: PI })
    stack.scripted.scriptError({ marker: failure.marker, status: failure.status, message: failure.message })
    await app.goto(`${stack.url}/w/${workspace.id}/s/${session.id}`)
    const prompt = app.getByRole("textbox", { name: "Ask anything, / for commands, @ for context..." })
    await prompt.fill(`Reply with exactly this one token: ${failure.marker}`)
    await prompt.press("Enter")

    await expect(app.getByText(failure.copy).first()).toBeVisible()
    expect(stack.scripted.requests.some((request) => JSON.stringify(request).includes(failure.marker))).toBe(true)
    await expect(app.getByRole("button", { name: "Type a message to get started", exact: true })).toBeVisible()
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
  await app.goto(`${stack.url}/w/${workspace.id}/s/${session.id}`)
  const prompt = app.getByRole("textbox", { name: "Ask anything, / for commands, @ for context..." })
  await expect(prompt).toBeVisible()
  await stack.daemon.close()
  await prompt.fill("This prompt never reaches the server")
  await prompt.press("Enter")

  await expect(app.getByText("Failed to send prompt")).toBeVisible()
  await expect(app.getByText(/The server could not be reached/)).toBeVisible()
  await expect(prompt).toContainText("This prompt never reaches the server")
  await stack.daemon.restart()
  const messages = await api.messages(workspace.directory, session.id)
  expect(messages.filter((message) => message.info.role === "user")).toHaveLength(0)
})
