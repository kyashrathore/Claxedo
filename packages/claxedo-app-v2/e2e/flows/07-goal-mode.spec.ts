import { type CliName, expect, installedCli, sendPrompt, sessionRoute, test } from "../harness"

test.skip(({ isMobile }) => isMobile, "flow 7 runs at desktop width")

const GOALS: readonly { readonly cli: CliName; readonly mode: string }[] = [
  { cli: "codex", mode: "native" },
  { cli: "claude", mode: "evaluated" },
]

for (const goal of GOALS) {
  test(`07 goal mode (${goal.mode}, ${goal.cli}): /goal starts a goal that the dock shows and the server records`, async ({ stack, api, app }) => {
    const availability = await installedCli(goal.cli)
    test.skip(!availability.available, availability.available ? "" : availability.reason)
    const workspace = await stack.daemon.makeWorkspace(`goal-${goal.cli}`)
    const session = await api.createSession(workspace.directory, { title: `Goal ${goal.cli}`, harness: { id: goal.cli, access: "native" } })
    await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
    await sendPrompt(app, "/goal Write GOALDONE into notes.md")

    const dock = app.getByRole("region", { name: "Goal", exact: true })
    await expect(dock).toBeVisible()
    await expect(dock).toContainText("Write GOALDONE into notes.md")
    const state = await fetch(`${stack.url}/session/${session.id}/goal/state?directory=${encodeURIComponent(workspace.directory)}`)
    expect(JSON.stringify(await state.json())).toContain("Write GOALDONE into notes.md")
  })
}
