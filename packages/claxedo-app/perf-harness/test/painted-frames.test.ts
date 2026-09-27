import { afterAll, beforeAll, expect, test } from "bun:test"
import { chromium, type Browser, type Page } from "playwright-core"
import { installPaintedFrames } from "../src/browser/painted-frames"

let browser: Browser

beforeAll(async () => {
  browser = await chromium.launch({ headless: true })
})

afterAll(async () => {
  await browser.close()
})

type Sampled = { readonly startedAt: number; readonly wroteAt: number | undefined; readonly pressedAt: number | undefined }
type FrameState = { sampled: Sampled[]; overtaken: number }

async function framePage(input: { readonly workMs: number }) {
  const page = await browser.newPage()
  await page.setContent(`<button style="width:200px;height:100px">press</button>`)
  await page.evaluate(installPaintedFrames)
  await page.evaluate(({ workMs }) => {
    const state: FrameState = { sampled: [], overtaken: 0 }
    Reflect.set(window, "frameState", state)
    const read = (name: string) => (document.body.dataset[name] === undefined ? undefined : Number(document.body.dataset[name]))
    document.querySelector("button")!.addEventListener("pointerdown", () => {
      document.body.dataset.pressedAt = String(performance.now())
    })
    window.__claxedoPaintedFrames!({
      sample: (startedAt) => ({ startedAt, wroteAt: read("wroteAt"), pressedAt: read("pressedAt") }),
      painted: (frame) => {
        state.sampled.push(frame)
      },
      overtaken: () => {
        state.overtaken += 1
      },
    })
    const work = () => {
      requestAnimationFrame(work)
      const end = performance.now() + workMs
      while (performance.now() < end);
      document.body.dataset.wroteAt = String(performance.now())
    }
    requestAnimationFrame(work)
  }, input)
  return page
}

const frameState = (page: Page) => page.evaluate(() => Reflect.get(window, "frameState") as FrameState)

const sampledFrames = (page: Page, count: number) =>
  page.waitForFunction((count) => (Reflect.get(window, "frameState") as FrameState).sampled.length >= count, count)

test("a frame's sample reads what the app wrote in that frame's requestAnimationFrame work", async () => {
  const page = await framePage({ workMs: 0 })
  await sampledFrames(page, 20)
  const written = (await frameState(page)).sampled.filter((frame) => frame.wroteAt !== undefined)
  expect(written.length).toBeGreaterThan(15)
  expect(written.filter((frame) => frame.wroteAt! < frame.startedAt)).toEqual([])
  await page.close()
}, 30_000)

test("a frame a click overtook between its paint and its sample is not sampled", async () => {
  const page = await framePage({ workMs: 8 })
  const early: Sampled[] = []
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.evaluate(() => {
      ;(Reflect.get(window, "frameState") as FrameState).sampled = []
      delete document.body.dataset.pressedAt
    })
    await page.mouse.move(100, 50)
    await page.mouse.down()
    await page.mouse.up()
    await sampledFrames(page, 4)
    early.push(...(await frameState(page)).sampled.filter((frame) => frame.pressedAt !== undefined && frame.startedAt < frame.pressedAt))
  }
  expect(early).toEqual([])
  expect((await frameState(page)).overtaken).toBeGreaterThan(0)
  await page.close()
}, 30_000)
