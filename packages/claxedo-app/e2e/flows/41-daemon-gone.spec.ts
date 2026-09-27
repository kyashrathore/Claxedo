import fs from "node:fs/promises"
import path from "node:path"
import { expect, test } from "../harness"

test("41 daemon gone: the desktop says its local service stopped, why, and offers the restart", { tag: "@desktop" }, async ({ desktop }) => {
  await expect(desktop.window.getByRole("heading", { level: 1, name: "Start with a project" })).toBeVisible()
  const discovery = JSON.parse(await fs.readFile(path.join(desktop.dataDir, "server-data", "local-daemon.json"), "utf8")) as { pid: number }

  process.kill(discovery.pid, "SIGKILL")

  const alert = desktop.window.getByRole("alert").filter({ hasText: "Claxedo's local service stopped" })
  await expect(alert).toContainText("signal SIGKILL")
  await expect(alert.getByRole("button", { name: "Reload window" })).toBeEnabled()
})
