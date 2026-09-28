import { chromium, type BrowserContext, type CDPSession, type Page } from "@playwright/test"
import fs from "node:fs/promises"
import path from "node:path"
import type { AcpScript } from "../../../../harness/e2e/harness/acp/script"
import { ClaxedoApi } from "../../harness/api"
import { launchDesktop } from "../../harness/desktop"
import { ensureDesktopBuilt } from "../../harness/desktop-build"
import { git } from "../../../../harness/e2e/harness/git"
import { prepareHarness } from "../../harness/global-setup"
import { startStack } from "../../harness/stack"
import type { Workspace } from "../../../../harness/e2e/harness/workspaces"
import { installPaintedFrames } from "../../../perf-harness/src/browser/painted-frames"
import { seedScriptedSession } from "../seed"
import type { ScreenBounds } from "./screen"

export type Surface = {
  api: ClaxedoApi
  workspace: Workspace
  url: string
  writeScript(name: string, script: AcpScript): Promise<void>
  release(name: string): Promise<void>
  daemonLog(): string
  open(): Promise<{ page: Page; cdp: CDPSession; bounds?: ScreenBounds }>
  close(): Promise<void>
}

const PROBE = path.join(import.meta.dirname, "probe.js")

async function installProbe(context: BrowserContext) {
  await context.addInitScript("globalThis.__name = (target) => target")
  await context.addInitScript(installPaintedFrames)
  await context.addInitScript({ path: PROBE })
}

export const dwell = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function mainThreadIdle(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestIdleCallback(() => resolve(), { timeout: 5_000 })))
}

export function seedSession(surface: Surface, title: string, turns: number) {
  return seedScriptedSession({ api: surface.api, directory: surface.workspace.directory, writeScript: surface.writeScript, title, turns })
}

export async function turnStarted(surface: Surface, sessionId: string, before: number) {
  while ((await surface.api.messages(surface.workspace.directory, sessionId)).length < before + 2) await dwell(100)
}

async function withValues(workspace: Workspace) {
  await fs.mkdir(path.join(workspace.directory, "src"), { recursive: true })
  await fs.writeFile(path.join(workspace.directory, "src/values.ts"), "export const value0 = 0\n")
  await git(workspace.directory, "add", "--", "src/values.ts")
  await git(workspace.directory, "commit", "-q", "-m", "values", "--", "src/values.ts")
  return workspace
}

export async function webSurface(scale: number): Promise<Surface> {
  await prepareHarness()
  const stack = await startStack({ label: "stream-switch" })
  const browser = await chromium.launch({ channel: "chromium" })
  return {
    api: new ClaxedoApi(stack.url),
    workspace: await withValues(await stack.daemon.makeWorkspace("switch", "Switch")),
    url: stack.url,
    writeScript: (name, script) => stack.acp.write(name, script),
    release: (name) => stack.acp.release(name),
    daemonLog: () => stack.daemon.log(),
    open: async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: scale, colorScheme: "light", locale: "en-US", timezoneId: "UTC" })
      await installProbe(context)
      const page = await context.newPage()
      return { page, cdp: await context.newCDPSession(page) }
    },
    close: async () => {
      await browser.close()
      await stack.close()
    },
  }
}

export async function desktopSurface(): Promise<Surface> {
  await prepareHarness()
  const build = await ensureDesktopBuilt()
  console.log(`[switch] desktop ${build.built ? `built in ${build.ms} ms` : "already built"}`)
  const desktop = await launchDesktop({ label: "stream-switch", red: false, renderer: "file" })
  return {
    api: desktop.api,
    workspace: await withValues(await desktop.makeWorkspace("switch", "Switch")),
    url: desktop.url,
    writeScript: (name, script) => desktop.acp.write(name, script),
    release: (name) => desktop.acp.release(name),
    daemonLog: () => desktop.log(),
    open: async () => {
      const page = desktop.window
      await desktop.electron.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find((candidate) => candidate.isVisible()) ?? BrowserWindow.getAllWindows()[0]!
        window.setContentSize(1440, 900)
        window.setPosition(0, 40)
        window.focus()
      })
      await installProbe(page.context())
      const bounds = await desktop.electron.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find((candidate) => candidate.isVisible()) ?? BrowserWindow.getAllWindows()[0]!
        return window.getContentBounds()
      })
      return { page, cdp: await page.context().newCDPSession(page), bounds }
    },
    close: () => desktop.close(),
  }
}
