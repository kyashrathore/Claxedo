import { acpScriptToken, assistantText, expect, SCRIPTED_ACP_HARNESS, sendPrompt, sessionRoute, test, UI } from "../harness"

for (const continuation of ["resume", "message"] as const) {
  test(`43 interrupted session: daemon crash stops the spinner and ${continuation} starts a real turn`, async ({ stack, api, app }) => {
    const workspace = await stack.daemon.makeWorkspace(`interrupted-${continuation}`)
    await stack.acp.write("interrupted", { steps: [
      { kind: "text", text: "Saved before the crash" },
      { kind: "hold", name: "interrupted" },
      { kind: "text", text: "Old turn continued unexpectedly" },
    ] })
    const session = await api.createSession(workspace.directory, { title: "Interrupted work", harness: SCRIPTED_ACP_HARNESS })
    await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
    await sendPrompt(app, `Start. ${acpScriptToken("interrupted")}`)
    await expect(app.getByText("Saved before the crash")).toBeVisible()
    const pid = stack.daemon.pid()
    if (!pid) throw new Error("The daemon has no running process")
    process.kill(pid, "SIGKILL")
    await stack.daemon.restart()
    await app.reload()

    const notice = app.getByRole("region", { name: "Session interrupted", exact: true })
    await expect(notice).toBeVisible()
    await expect(app.locator('[data-sidebar-status="working"]')).toHaveCount(0)
    await expect(app.getByRole("button", { name: UI.sendIdle })).toBeVisible()
    await expect(app.getByRole("button", { name: UI.stop, exact: true })).toHaveCount(0)
    expect((await api.status(workspace.directory))[session.id]?.type).toBe("interrupted")
    expect((await api.messages(workspace.directory, session.id)).filter((message) => message.info.role === "user")).toHaveLength(1)

    if (continuation === "resume") {
      await notice.getByRole("button", { name: "Resume", exact: true }).click()
    } else {
      await sendPrompt(app, "Continue from the saved work")
    }
    await expect(notice).toHaveCount(0)
    await expect.poll(async () => (await api.session(workspace.directory, session.id)).lastTurn).toMatchObject({ status: "completed" })
    const messages = await api.messages(workspace.directory, session.id)
    expect(messages.filter((message) => message.info.role === "user")).toHaveLength(2)
    expect(assistantText(messages)).toContain("Saved before the crash")
    expect(assistantText(messages)).not.toContain("Old turn continued unexpectedly")
    await app.reload()
    await expect(notice).toHaveCount(0)
    await expect(app.getByRole("button", { name: UI.sendIdle })).toBeVisible()
  })
}
