import { expect, type Page } from "@playwright/test"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"

export async function expectRunningChildCleanup(page: Page, input: {
  backendUrl: string
  directory: string
  parentHarness: "claude" | "codex"
  childHarness: "claude" | "codex"
  action: "Archive" | "Delete"
  startChild: (sessionId: string, command: string, marker: string) => Promise<void>
}) {
  const query = `?directory=${encodeURIComponent(input.directory)}`
  const create = async (harness: "claude" | "codex", title: string, parentID?: string) => {
    const response = await page.request.post(`${input.backendUrl}/session${query}&nativeHarness=${harness}`, {
      data: { title, harness: { id: harness, access: "native" }, permissionCeiling: "full",
        permissionMode: harness === "claude" ? "bypassPermissions" : "full-access", ...(parentID ? { parentID } : {}) },
    })
    expect(response.ok(), await response.text()).toBe(true)
    return await response.json() as { id: string }
  }
  const parent = await create(input.parentHarness, "Parent cleanup target")
  const child = await create(input.childHarness, "Running child", parent.id)
  const neighbor = await create(input.childHarness, "Unrelated session")
  const pidFile = path.join(input.directory, "child.pid")
  const release = path.join(input.directory, "child-release")
  const finished = path.join(input.directory, "child-finished")
  const workload = path.join(input.directory, "child-workload.cjs")
  await fs.writeFile(workload, `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); const timer = setInterval(() => { if (!fs.existsSync(${JSON.stringify(release)})) return; fs.writeFileSync(${JSON.stringify(finished)}, "leaked"); clearInterval(timer); }, 50);`)
  const sessionPath = (id: string) => `/${Buffer.from(input.directory).toString("base64url")}/session/${id}`
  try {
    await input.startChild(child.id, `node '${workload}'`, `CHILD-CLEANUP-${Date.now()}`)
    await expect.poll(() => fs.readFile(pidFile, "utf8").catch(() => ""), { timeout: 60_000 }).toMatch(/^\d+$/)
    const pid = Number(await fs.readFile(pidFile, "utf8"))
    const alive = () => {
      try {
        const status = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim()
        return status.length > 0 && !status.startsWith("Z")
      } catch (error) {
        if ((error as { status?: number }).status === 1) return false
        throw error
      }
    }
    expect(alive()).toBe(true)
    await page.goto(sessionPath(parent.id))
    await page.getByRole("button", { name: "More options", exact: true }).click()
    await page.getByRole("menuitem", { name: input.action, exact: true }).click()
    if (input.action === "Delete") await page.getByRole("button", { name: "Delete session", exact: true }).click()
    await expect.poll(alive, { timeout: 15_000, message: `${input.action} left the ${input.childHarness} child tool running` }).toBe(false)
    await fs.writeFile(release, "release")
    await page.goto(sessionPath(neighbor.id))
    await expect(page.getByRole("button", { name: "More options", exact: true })).toBeVisible()
    await page.reload()
    await expect(page.getByRole("textbox", { name: /Ask anything/i }).last()).toBeVisible()
    for (const id of [parent.id, child.id]) {
      const response = await page.request.get(`${input.backendUrl}/session/${id}${query}`)
      if (input.action === "Delete") expect(response.status()).toBe(404)
      else {
        expect(response.ok(), await response.text()).toBe(true)
        expect((await response.json() as { time: { archived?: number } }).time.archived).toBeGreaterThan(0)
      }
    }
    const preserved = await page.request.get(`${input.backendUrl}/session/${neighbor.id}${query}`)
    expect(preserved.ok()).toBe(true)
    const row = await preserved.json() as { id: string; title: string; time: { archived?: number } }
    expect(row).toMatchObject({ id: neighbor.id, title: "Unrelated session" })
    expect(row.time.archived).toBeFalsy()
    expect(await fs.access(finished).then(() => true, () => false)).toBe(false)
  } finally {
    await fs.writeFile(release, "release")
  }
}
