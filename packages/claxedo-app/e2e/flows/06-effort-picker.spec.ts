import { expect, sendPrompt, sessionRoute, test } from "../harness"

test("06 effort picker: an OpenCode model's effort variants show in the picker, and the chosen one is the variant the engine runs", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("opencode-effort")
  const session = await api.createSession(workspace.directory, { title: "OpenCode effort", harness: { id: "opencode", access: "native" },
    model: { providerId: "anthropic", modelId: "claude-sonnet-4-5" } })
  stack.scripted.scriptText({ marker: "EFFORTPICKED", text: "EFFORTPICKED" })
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await app.getByRole("button", { name: /^Select harness and model/ }).click()
  const picker = app.getByRole("dialog", { name: "Select harness, model and effort" })
  const effort = picker.getByRole("slider", { name: "Effort" })
  await expect(effort).toBeVisible()
  await effort.focus()
  await app.keyboard.press("End")
  const chosen = await effort.getAttribute("aria-valuetext")
  expect(chosen).toBeTruthy()
  await app.keyboard.press("Escape")
  await sendPrompt(app, "Reply with exactly EFFORTPICKED")
  await expect(app.getByText("EFFORTPICKED", { exact: true }).last()).toBeVisible()
  const sent = (await api.messages(workspace.directory, session.id)).find((message) => message.info.role === "user")?.info as { variant?: string } | undefined
  expect(sent?.variant?.toLowerCase()).toBe(chosen?.toLowerCase())
})
