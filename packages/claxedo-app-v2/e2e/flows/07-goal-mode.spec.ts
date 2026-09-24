import { type CliName, expect, installedCli, type ModelChoice, sessionRoute, test, UI } from "../harness"

test.skip(({ isMobile }) => isMobile, "flow 7 runs at desktop width")

const GOALS: readonly { readonly cli: CliName; readonly mode: string }[] = [
  { cli: "codex", mode: "native" },
  { cli: "claude", mode: "evaluated" },
]

type HarnessOptions = { options: readonly { id: string; currentValue?: string }[] }

async function defaultModel(url: string, directory: string, cli: CliName): Promise<ModelChoice> {
  const query = new URLSearchParams({ directory, nativeHarness: cli })
  const response = await fetch(new URL(`/api/claxedo/agent-config/harness/options?${query}`, url))
  expect(response.status).toBe(200)
  const modelId = ((await response.json()) as HarnessOptions).options.find((option) => option.id === "model")?.currentValue
  expect(modelId, `${cli} offers a default model`).toBeTruthy()
  return { providerId: cli, modelId: modelId ?? "" }
}

for (const goal of GOALS) {
  test(`07 goal mode (${goal.mode}, ${goal.cli}): /goal starts a goal that the dock shows and the server records`, async ({ stack, api, app }) => {
    const availability = await installedCli(goal.cli)
    test.skip(!availability.available, availability.available ? "" : availability.reason)
    const workspace = await stack.daemon.makeWorkspace(`goal-${goal.cli}`)
    const model = await defaultModel(stack.url, workspace.directory, goal.cli)
    const session = await api.createSession(workspace.directory, { title: `Goal ${goal.cli}`, harness: { id: goal.cli, access: "native" }, model })
    await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
    await app.getByRole("textbox", { name: UI.composer }).click()
    await app.keyboard.type("/goal")
    await app.keyboard.press("Enter")
    await expect(app.getByRole("textbox", { name: "Describe the outcome this Goal should reach" })).toBeVisible()
    await app.keyboard.type("Write GOALDONE into notes.md")
    await expect(app.getByRole("button", { name: UI.send, exact: true })).toBeEnabled()
    const release = stack.scripted.holdTextReplies("GOALDONE")
    await app.keyboard.press("Enter")

    const dock = app.getByRole("region", { name: "Goal", exact: true })
    await expect(dock).toBeVisible()
    await expect(dock).toContainText("Write GOALDONE into notes.md")
    const state = await fetch(`${stack.url}/session/${session.id}/goal/state?directory=${encodeURIComponent(workspace.directory)}`)
    expect(JSON.stringify(await state.json())).toContain("Write GOALDONE into notes.md")
    release()
  })
}
