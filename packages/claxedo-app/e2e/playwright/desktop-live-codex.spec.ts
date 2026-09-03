import { expect, test, type Locator } from "@playwright/test"
import { execFile } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { expectServerReachable, launchPackagedApp, type PackagedApp } from "../helpers/electron-app"

const execFileAsync = promisify(execFile)

async function compose(input: Locator, text: string) {
  await input.click()
  await input.fill(text)
  await expect(input).toContainText(text, { timeout: 10_000 })
}

test("packaged Windows app completes a real Codex-authenticated session @live @surface-desktop", async () => {
  test.setTimeout(240_000)
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-windows-live-codex-")))
  await execFileAsync("git", ["init"], { cwd: directory })
  await fs.writeFile(path.join(directory, "README.md"), "Real Windows Codex desktop proof.\n")

  let packaged: PackagedApp | undefined
  try {
    packaged = await launchPackagedApp({
      timeoutMs: 60_000,
      env: { CODEX_HOME: path.join(os.homedir(), ".codex") },
    })
    const serverBase = new URL(await expectServerReachable(packaged, 45_000)).origin
    const resolve = await fetch(
      `${serverBase}/api/claxedo/workspace/resolve?directory=${encodeURIComponent(directory)}&create=true`,
    )
    const resolved = await resolve.json() as { workspaceId?: string; error?: unknown }
    expect(resolve.status, JSON.stringify(resolved)).toBe(200)
    expect(resolved.workspaceId).toBeTruthy()
    const workspaceId = resolved.workspaceId!

    await packaged.page.evaluate(async (worktree) => {
      const api = (window as unknown as {
        api: { storeSet(name: string, key: string, value: string): Promise<void> }
      }).api
      await api.storeSet("opencode.global.dat", "server", JSON.stringify({
        list: [],
        projects: { local: [{ worktree, expanded: true }] },
        lastProject: {},
        workspaceServer: {},
        closedProjects: {},
      }))
    }, directory)
    await packaged.page.reload()
    await packaged.page.waitForLoadState("domcontentloaded")

    const project = packaged.page.locator(`[data-testid="project-group"][data-project-id="${workspaceId}"]`)
    await expect(project).toBeVisible({ timeout: 30_000 })
    // The header's action cluster mounts on engagement (hover, focus or an
    // explicit hold — `rail-hover-engagement.ts`), so the pointer has to reach
    // the header before its "New session" button exists.
    await project.locator('[data-testid="project-header"]').hover()
    await project.locator('[aria-label="New session in main"]').click()

    const input = packaged.page.locator('[role="textbox"][aria-label*="Ask anything"]:visible').last()
    await expect(input).toBeVisible({ timeout: 20_000 })
    const control = packaged.page.locator('[data-action="prompt-harness-model"]:visible').last()
    await control.click()
    const picker = packaged.page.locator('[data-component="harness-model-picker"]')
    await picker.locator('[data-slot="harness-picker-section"]').first().click()
    // "Codex" is unique now: the first-party ACP rows left the picker when
    // operator-configured ACP connections became the ACP group.
    const nativeCodex = picker.getByRole("button", { name: /^Codex$/ }).first()
    await nativeCodex.click()
    await picker.locator('[data-slot="harness-picker-section"]').first().click()
    await expect(nativeCodex, "native Codex harness did not become selected").toHaveAttribute(
      "aria-current",
      "true",
      { timeout: 45_000 },
    )
    await packaged.page.keyboard.press("Escape")
    await expect(control).not.toContainText(/Loading models|Select model|^$/, { timeout: 45_000 })

    const marker = "WINDOWS_CODEX_APP_OK"
    await compose(input, `Reply with exactly this token and nothing else: ${marker}`)
    const submit = packaged.page.locator('[data-action="prompt-submit"]:visible').last()
    await expect(submit).toBeEnabled({ timeout: 10_000 })
    const createResponse = packaged.page.waitForResponse((response) => {
      const url = new URL(response.url())
      return response.request().method() === "POST" && url.pathname === "/session"
    })
    await submit.click()
    const created = await createResponse
    if (!created.ok()) {
      throw new Error(
        `real Codex session creation failed (${created.status()}): ${await created.text()}. ` +
          `App log tail: ${packaged.appLog.join("").split("\n").slice(-30).join("\n")}`,
      )
    }
    await expect(
      packaged.page.locator('[data-slot="session-turn-assistant-content"]:visible').filter({ hasText: marker }),
      "the real Codex session did not render its authenticated response",
    ).toBeVisible({ timeout: 180_000 })
    await packaged.page.waitForTimeout(8_000)
  } finally {
    await packaged?.close()
    await fs.rm(directory, { recursive: true, force: true })
  }
})
