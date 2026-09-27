import { afterAll, beforeAll, expect, test } from "bun:test"
import { chromium, type Browser } from "playwright-core"
import type { BenchmarkPage } from "../src/agent-cdp-page"
import { installPaintedFrames } from "../src/browser/painted-frames"
import { measurePrearmedSettledAction } from "../src/public-workspace-panel"
import { waitForPaintedFile } from "../src/workspace-panel-readiness"

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

async function benchmarkPage() {
  const page = await browser.newPage()
  await page.setContent(FILE_ON_PRESS)
  await page.evaluate(installPaintedFrames)
  const cdp = await page.context().newCDPSession(page)
  const adapted = {
    evaluate: page.evaluate.bind(page),
    rawCommand: (method: string, params?: Record<string, unknown>) => cdp.send(method as "Tracing.start", params),
    onProtocolEvent: (method: string, listener: (params: unknown) => void) => {
      cdp.on(method as "Tracing.dataCollected", listener)
      return () => {
        cdp.off(method as "Tracing.dataCollected", listener)
      }
    },
  } as Pick<BenchmarkPage, "evaluate" | "rawCommand" | "onProtocolEvent"> as never
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
