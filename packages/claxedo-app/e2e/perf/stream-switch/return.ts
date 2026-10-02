import type { Page } from "@playwright/test"
import fs from "node:fs/promises"
import path from "node:path"
import { acpScriptToken } from "../../../../harness/e2e/harness/acp/script"
import { sessionRoute } from "../../harness/ui-names"
import { streamScript } from "../stream-script"
import { dwell, mainThreadIdle, seedSession, webSurface, type Surface } from "./surface"

const AWAY = (process.env.AWAY ?? "1000,3000,6000").split(",").map(Number)
const FRAMES = Number(process.env.FRAMES ?? "40")
const OUT = process.env.OUT ?? path.join(process.env.HOME ?? "", "test/claxedo-perf-private/perf/stream-switch/return")

type ReturnFrame = { at: number; shown: boolean; length: number; tail: string; rows: number }
type ReturnWindow = Window & { __returnFrames?: Promise<ReturnFrame[]> }

async function recordReturn(page: Page, sessionId: string, frames: number) {
  await page.evaluate(
    ({ id, count }) => {
      ;(window as ReturnWindow).__returnFrames = new Promise<ReturnFrame[]>((resolve) => {
        const out: ReturnFrame[] = []
        const started = performance.now()
        const paintedFrames = window.__claxedoPaintedFrames
        if (!paintedFrames) throw new Error("installPaintedFrames has not run in this page")
        paintedFrames({
          sample: () => {
            const root = document.querySelector<HTMLElement>(`[data-testid="session-page-root"][data-session-id="${id}"]`)
            const shown = !!root?.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true }) && !!root.querySelector("[data-timeline-key]")
            const text = shown ? (root!.querySelector("[data-session-timeline-root]")?.textContent ?? "") : ""
            return { shown, length: text.length, tail: text.slice(-60), rows: root?.querySelectorAll("[data-timeline-key]").length ?? 0 }
          },
          painted: (frame, at) => {
            if (frame.shown || out.length > 0) out.push({ at: Math.round(at - started), ...frame })
            if (out.length < count) return false
            resolve(out)
            return true
          },
        })
      })
    },
    { id: sessionId, count: frames },
  )
  return () => page.evaluate(() => (window as ReturnWindow).__returnFrames!)
}

async function saveFailure(surface: Surface, page: Page, logs: readonly string[]) {
  await page.screenshot({ path: path.join(OUT, "failure.png") })
  await fs.writeFile(path.join(OUT, "failure-console.txt"), logs.join("\n"))
  await fs.writeFile(path.join(OUT, "failure-daemon.log"), surface.daemonLog().split("\n").slice(-400).join("\n"))
}

async function main() {
  await fs.mkdir(OUT, { recursive: true })
  const surface = await webSurface(1)
  try {
    const { page } = await surface.open()
    const logs: string[] = []
    page.on("console", (message) => logs.push(`${message.type()} ${message.text()}`))
    await measureReturns(surface, page).catch(async (error: unknown) => {
      await saveFailure(surface, page, logs)
      throw error
    })
  } finally {
    await surface.close()
  }
}

async function measureReturns(surface: Surface, page: Page) {
  const { api, workspace } = surface
  const alpha = await seedSession(surface, "Alpha", 1)
  const bravo = await seedSession(surface, "Bravo", 1)
  await surface.writeScript("stream-a", streamScript(workspace.directory))
  await page.goto(`${surface.url}${sessionRoute(workspace.id, alpha)}`)
  await page.getByText("Seed turn 1 done.").first().waitFor({ state: "visible", timeout: 60_000 })
  await api.promptAsync(workspace.directory, alpha, `Write the long report. ${acpScriptToken("stream-a")}`)
  await page.getByText("Streaming report").first().waitFor({ state: "visible", timeout: 30_000 })
  const row = (id: string) => page.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${id}"]`)
  const results = []
  for (const away of AWAY) {
    await row(bravo).click()
    await page.getByText("Seed turn 1 done.").first().waitFor({ state: "visible" })
    await dwell(away)
    const done = await recordReturn(page, alpha, FRAMES)
    await row(alpha).click()
    const frames = await done()
    results.push({ away, frames })
    const steps = frames.map((frame, index) => `${frame.at}:${frame.length - (frames[index - 1]?.length ?? frame.length)}`)
    console.log(`[return] away ${away} ms: first ${frames[0]?.length} chars; growth per frame ${steps.slice(1, 24).join(" ")}`)
    await mainThreadIdle(page)
  }
  await fs.writeFile(path.join(OUT, "return.json"), JSON.stringify({ alpha, bravo, results }, null, 1))
}

await main()
