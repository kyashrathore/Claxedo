import { afterAll, beforeAll, expect, test } from "bun:test"
import { chromium, type Browser } from "playwright-core"
import type { BenchmarkPage } from "../src/agent-cdp-page"
import { installPaintedFrames } from "../src/browser/painted-frames"
import { measurePanelOpen, measurePrearmedSettledAction } from "../src/public-workspace-panel"
import { waitForPaintedFile } from "../src/workspace-panel-readiness"
import { beginTrace, finishMeasuredTrace, markActionEnd } from "../src/workspace-panel-trace-recording"

let browser: Browser

beforeAll(async () => {
  browser = await chromium.launch({ headless: true })
}, 30_000)

afterAll(async () => {
  await browser.close()
})

const FILE_ON_PRESS = `
  <button type="button" style="width:200px;height:100px">open</button>
  <script>
    document.querySelector("button").addEventListener("pointerdown", () => {
      document.body.insertAdjacentHTML("beforeend", '<div data-testid="tab-file-root" data-tab-file-path="a.ts" data-tab-file-state="ready" data-tab-file-render-state="painted" data-tab-file-rendered-cache-key="a" data-tab-file-content-chars="3" style="width:100px;height:40px">abc</div>')
    })
  </script>
`

const PANEL_ON_PRESS = `
  <button type="button" data-testid="workspace-panel-toggle" aria-label="Open workspace panel" style="width:200px;height:100px">toggle</button>
  <script>
    document.querySelector("button").addEventListener("pointerdown", () => {
      document.body.insertAdjacentHTML("beforeend", '<div data-testid="workspace-panel-shell" data-open="true" data-shell-settled="true" data-state-workspace-dir="/w" style="width:300px;height:200px"><div data-testid="workspace-files-navigator" data-mode="files" data-file-tree-data-ready="true" style="width:300px;height:200px"><button data-file-tree-path="a.ts">a.ts</button></div></div>')
    })
  </script>
`

async function benchmarkPage(content = FILE_ON_PRESS) {
  const page = await browser.newPage()
  await page.setContent(content)
  await page.evaluate(installPaintedFrames)
  const cdp = await page.context().newCDPSession(page)
  const adapted = {
    evaluate: page.evaluate.bind(page),
    locator: page.locator.bind(page),
    rawCommand: (method: string, params?: Record<string, unknown>) => cdp.send(method as "Tracing.start", params),
    onProtocolEvent: (method: string, listener: (params: unknown) => void) => {
      cdp.on(method as "Tracing.dataCollected", listener)
      return () => {
        cdp.off(method as "Tracing.dataCollected", listener)
      }
    },
  } as Pick<BenchmarkPage, "evaluate" | "locator" | "rawCommand" | "onProtocolEvent"> as never
  return { page, adapted }
}

test("an action painted in the first frame after its pointerdown still spans two presented frames", async () => {
  for (let run = 0; run < 20; run += 1) {
    const { page, adapted } = await benchmarkPage()
    await page.mouse.move(100, 50)
    const { clock, rendererTrace } = await measurePrearmedSettledAction(
      adapted,
      () => waitForPaintedFile(adapted, "a.ts", true),
      () => page.mouse.down(),
    )
    await page.mouse.up()
    const frames = rendererTrace.frameTimestampsMs
    const actionPainted = rendererTrace.milestones.find((milestone) => milestone.id === "action-painted")!.at
    expect(frames.length).toBeGreaterThanOrEqual(2)
    expect(frames.every((at) => at >= clock.start && at <= clock.end + 0.5)).toBe(true)
    expect(actionPainted).toBeLessThanOrEqual(clock.end)
    expect(rendererTrace.milestones.find((milestone) => milestone.id === "interactive")!.at).toBe(clock.end)
    expect(rendererTrace.counterInterval).toEqual({ start: clock.start, end: clock.end })
    await page.close()
  }
}, 30_000)

test("an action end asked for inside its ready frame's own task waits for the second presented frame", async () => {
  const { page, adapted } = await benchmarkPage()
  await page.evaluate(() => {
    const paintedFrames = window.__claxedoPaintedFrames!
    window.__claxedoPaintedFrames = (frame) => paintedFrames({
      sample: frame.sample,
      painted: (value, paintedAt) => {
        const stop = frame.painted(value, paintedAt)
        const trace = window.__claxedoPublicPanelTrace
        const inputAt = trace?.trustedInputAt
        const deferred = Reflect.get(window, "deferred") as (() => void) | undefined
        if (inputAt !== undefined && deferred && trace!.frames.filter((presented) => presented.startedAt >= inputAt).length === 1) {
          Reflect.deleteProperty(window, "deferred")
          deferred()
        }
        return stop
      },
    })
  })
  const inReadyFrame = {
    evaluate: <A>(fn: (arg: A) => unknown, arg: A) => page.evaluate(({ source, arg }) => new Promise((resolve, reject) => {
      Reflect.set(window, "deferred", () => {
        try {
          resolve(new Function(`return (${source})`)()(arg))
        } catch (error) {
          reject(error)
        }
      })
    }), { source: fn.toString(), arg }),
  } as never
  const recording = await beginTrace(adapted)
  await page.mouse.move(100, 50)
  const ended = markActionEnd(inReadyFrame, 0)
  await page.waitForFunction(() => Reflect.has(window, "deferred"))
  await page.mouse.down()
  await ended
  const { clock, rendererTrace } = await finishMeasuredTrace(adapted, recording)
  await page.mouse.up()
  expect(rendererTrace.frameTimestampsMs.length).toBe(2)
  expect(clock.end).toBe(rendererTrace.frameTimestampsMs[1]!)
  await page.close()
}, 30_000)

test("a panel open ends at its above-fold paint or its second presented frame, not when the driver finishes the trace", async () => {
  const { page, adapted } = await benchmarkPage(PANEL_ON_PRESS)
  const { clock, rendererTrace } = await measurePanelOpen(adapted, { manifest: {} as never, files: ["a.ts"], changed: [], openFiles: [] })
  const aboveFold = rendererTrace.milestones.find((milestone) => milestone.id === "above-fold-painted")!.at
  expect(rendererTrace.frameTimestampsMs.length).toBeGreaterThanOrEqual(2)
  expect(clock.end).toBe(Math.max(aboveFold, rendererTrace.frameTimestampsMs[1]!))
  await page.close()
}, 30_000)
