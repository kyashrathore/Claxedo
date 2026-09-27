import type { Page } from "@playwright/test"
import fs from "node:fs/promises"
import path from "node:path"
import { SCRIPTED_ACP_HARNESS } from "../../harness/acp/connection"
import { acpScriptToken } from "../../harness/acp/script"
import { sessionRoute } from "../../harness/ui-names"
import { seedTurnScript, streamScript } from "../stream-script"
import { webSurface, type Surface } from "./surface"

const AWAY = (process.env.AWAY ?? "1000,3000,6000").split(",").map(Number)
const FRAMES = Number(process.env.FRAMES ?? "40")
const OUT = process.env.OUT ?? path.join(process.env.HOME ?? "", "test/claxedo-perf-private/perf/stream-switch/return")

type ReturnFrame = { at: number; shown: boolean; length: number; tail: string; rows: number }
type ReturnWindow = Window & { __returnFrames?: Promise<ReturnFrame[]> }

async function seedSession(surface: Surface, title: string) {
  const { api, workspace } = surface
  const session = await api.createSession(workspace.directory, { title, harness: SCRIPTED_ACP_HARNESS })
  const script = `${title}-seed`
  await surface.writeScript(script, seedTurnScript(workspace.directory, 1))
  await api.prompt(workspace.directory, session.id, `Earlier question. ${acpScriptToken(script)}`)
  return session.id
}

async function recordReturn(page: Page, sessionId: string, frames: number) {
  await page.evaluate("globalThis.__name = (target) => target")
  await page.evaluate(
    ({ id, count }) => {
      ;(window as ReturnWindow).__returnFrames = new Promise<ReturnFrame[]>((resolve) => {
        const out: ReturnFrame[] = []
        const started = performance.now()
        const painted = new MessageChannel()
        const afterPaint = () => painted.port2.postMessage(undefined)
        painted.port1.onmessage = () => {
          const root = document.querySelector<HTMLElement>(`[data-testid="session-page-root"][data-session-id="${id}"]`)
          const shown = !!root?.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true }) && !!root.querySelector("[data-timeline-key]")
          const text = shown ? (root!.querySelector("[data-session-timeline-root]")?.textContent ?? "") : ""
          if (shown || out.length > 0) out.push({ at: Math.round(performance.now() - started), shown, length: text.length, tail: text.slice(-60), rows: root?.querySelectorAll("[data-timeline-key]").length ?? 0 })
          if (out.length >= count) return resolve(out)
          requestAnimationFrame(afterPaint)
        }
        requestAnimationFrame(afterPaint)
      })
    },
    { id: sessionId, count: frames },
  )
  return () => page.evaluate(() => (window as ReturnWindow).__returnFrames!)
}

async function main() {
  await fs.mkdir(OUT, { recursive: true })
  const surface = await webSurface(1)
  try {
    const { api, workspace } = surface
    const alpha = await seedSession(surface, "Alpha")
    const bravo = await seedSession(surface, "Bravo")
    await surface.writeScript("stream-a", streamScript(workspace.directory))
    const { page } = await surface.open()
    await page.goto(`${surface.url}${sessionRoute(workspace.id, alpha)}`)
    await page.getByText("Seed turn 1 done.").first().waitFor({ state: "visible", timeout: 60_000 })
    await api.promptAsync(workspace.directory, alpha, `Write the long report. ${acpScriptToken("stream-a")}`)
    await page.getByText("Streaming report").first().waitFor({ state: "visible", timeout: 30_000 })
    const row = (id: string) => page.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${id}"]`)
    const results = []
    for (const away of AWAY) {
      const left = await page.evaluate(() => performance.now())
      await row(bravo).click()
      await page.getByText("Seed turn 1 done.").first().waitFor({ state: "visible" })
      await page.waitForTimeout(away)
      const done = await recordReturn(page, alpha, FRAMES)
      await row(alpha).click()
      const frames = await done()
      const commits = (await page.evaluate("globalThis.__dx ?? []")) as { at: number; chars: number; stack: string }[]
      for (const commit of commits.filter((entry) => entry.at >= left).slice(0, 60)) console.log(`[return]   commit +${Math.round(commit.at - left)} ms ${commit.chars} chars ${commit.stack.slice(0, 400)}`)
      results.push({ away, frames })
      const steps = frames.map((frame, index) => `${frame.at}:${frame.length - (frames[index - 1]?.length ?? frame.length)}`)
      console.log(`[return] away ${away} ms: first ${frames[0]?.length} chars; growth per frame ${steps.slice(1, 24).join(" ")}`)
      await page.waitForTimeout(800)
    }
    await fs.writeFile(path.join(OUT, "return.json"), JSON.stringify({ alpha, bravo, results }, null, 1))
  } finally {
    await surface.close()
  }
}

await main()
