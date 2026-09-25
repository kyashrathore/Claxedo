import { acpScriptToken, expect, SCRIPTED_ACP_HARNESS, sessionRoute, test, UI } from "../harness"
import { openSettings, revealRail } from "./15-settings.navigation"

test("15 settings: a background session's finished turn plays the alert sound and shows a system notification; Sounds can turn it off", async ({ stack, api, app, isMobile }) => {
  await app.addInitScript(() => {
    const record = window as unknown as { alertPlays: number; alertNotes: string[] }
    record.alertPlays = 0
    record.alertNotes = []
    HTMLMediaElement.prototype.play = function play() {
      record.alertPlays += 1
      return Promise.resolve()
    }
    class RecordedNotification {
      static permission = "granted"
      static requestPermission = () => Promise.resolve("granted")
      onclick: (() => void) | null = null
      constructor(title: string, options?: { body?: string }) {
        record.alertNotes.push(`${title}: ${options?.body ?? ""}`)
      }
      close() {}
    }
    Object.defineProperty(window, "Notification", { value: RecordedNotification, configurable: true })
    document.hasFocus = () => false
  })
  const workspace = await stack.daemon.makeWorkspace("alerts")
  await stack.acp.write("alert", { steps: [{ kind: "hold", name: "alert" }, { kind: "text", text: "Alerted" }] })
  const background = await api.createSession(workspace.directory, { title: "Background turn", harness: SCRIPTED_ACP_HARNESS })
  await app.goto(`${stack.url}${sessionRoute(workspace.id, background.id)}`)
  await expect(app.getByRole("textbox", { name: UI.composer })).toBeVisible()
  await app.goto(`${stack.url}${sessionRoute(workspace.id)}`)
  await expect(app.getByRole("textbox", { name: UI.composer })).toBeVisible()
  const plays = () => app.evaluate(() => (window as unknown as { alertPlays: number }).alertPlays)
  const notes = () => app.evaluate(() => (window as unknown as { alertNotes: string[] }).alertNotes)
  await api.promptAsync(workspace.directory, background.id, `Go. ${acpScriptToken("alert")}`)
  await expect.poll(async () => (await api.status(workspace.directory))[background.id]?.type ?? "idle").toBe("busy")
  await stack.acp.release("alert")
  await expect.poll(notes).toEqual(["Response ready: Background turn"])
  if (stack.app !== "v2") return
  await test.step("v2 approved: the alert plays for any session not on screen (DECISIONS Orchestrator 03:20)", async () => {
    await expect.poll(plays).toBe(1)
  })
  await test.step("v2 approved: Sounds is its own section and a sound can be None (DECISIONS Owner, 00:55 and 00:50)", async () => {
    await openSettings(stack, app, isMobile)
    await revealRail(stack, app, isMobile)
    await app.getByRole("link", { name: "Sound effects", exact: true }).click()
    await app.locator('[data-action="settings-sounds-agent"]').click()
    await app.getByRole("option", { name: "None", exact: true }).click()
    await app.goto(`${stack.url}${sessionRoute(workspace.id)}`)
    await expect(app.getByRole("textbox", { name: UI.composer })).toBeVisible()
    await stack.acp.write("again", { steps: [{ kind: "hold", name: "again" }, { kind: "text", text: "Again" }] })
    await api.promptAsync(workspace.directory, background.id, `Again. ${acpScriptToken("again")}`)
    await expect.poll(async () => (await api.status(workspace.directory))[background.id]?.type ?? "idle").toBe("busy")
    await stack.acp.release("again")
    await expect.poll(notes).toEqual(["Response ready: Background turn"])
    expect(await plays()).toBe(0)
  })
})
