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

type Sampled = {
  readonly startedAt: number
  readonly paintedAt: number
  readonly wroteAt: number | undefined
  readonly resizedAt: number | undefined
  readonly pressedAt: number | undefined
}

async function framePage(input: { readonly workMs: number }) {
  const page = await browser.newPage()
  await page.setContent(`<button style="width:200px;height:100px">press</button><div style="width:1px;height:1px"></div>`)
  await page.evaluate(installPaintedFrames)
  await page.evaluate(({ workMs }) => {
    const sampled: Sampled[] = []
    Reflect.set(window, "sampled", sampled)
    const read = (name: string) => (document.body.dataset[name] === undefined ? undefined : Number(document.body.dataset[name]))
    document.querySelector("button")!.addEventListener("pointerdown", () => {
      document.body.dataset.pressedAt = String(performance.now())
    })
    window.__claxedoPaintedFrames!({
      sample: (startedAt) => ({ startedAt, wroteAt: read("wroteAt"), resizedAt: read("resizedAt"), pressedAt: read("pressedAt") }),
      painted: (frame, paintedAt) => {
        sampled.push({ ...frame, paintedAt })
      },
    })
    const box = document.querySelector("div")!
    new ResizeObserver(() => {
      document.body.dataset.resizedAt = String(performance.now())
    }).observe(box)
    const work = () => {
      requestAnimationFrame(work)
      const end = performance.now() + workMs
      while (performance.now() < end);
      document.body.dataset.wroteAt = String(performance.now())
      box.style.width = box.style.width === "2px" ? "1px" : "2px"
    }
    requestAnimationFrame(work)
  }, input)
  return page
}

const sampledFrames = (page: Page) => page.evaluate(() => Reflect.get(window, "sampled") as Sampled[])

const waitForSampled = (page: Page, count: number) => page.waitForFunction((count) => (Reflect.get(window, "sampled") as Sampled[]).length >= count, count)

test("a frame's sample reads what the app wrote in that frame's requestAnimationFrame and ResizeObserver callbacks", async () => {
  const page = await framePage({ workMs: 0 })
  await waitForSampled(page, 20)
  const written = (await sampledFrames(page)).filter((frame) => frame.wroteAt !== undefined && frame.resizedAt !== undefined)
  expect(written.length).toBeGreaterThan(15)
  expect(written.filter((frame) => frame.wroteAt! < frame.startedAt || frame.resizedAt! < frame.wroteAt!)).toEqual([])
  await page.close()
}, 30_000)

test("a frame a task changed between its paint and its stamp is sampled as it was painted", async () => {
  const page = await browser.newPage()
  await page.setContent(`<p>idle</p>`)
  await page.evaluate(installPaintedFrames)
  await page.evaluate(() => {
    const sampled: { startedAt: number; taskAt: number | undefined }[] = []
    Reflect.set(window, "sampled", sampled)
    const task = new MessageChannel()
    task.port1.onmessage = () => {
      document.body.dataset.taskAt = String(performance.now())
    }
    const post = () => {
      requestAnimationFrame(post)
      task.port2.postMessage(undefined)
    }
    requestAnimationFrame(post)
    requestAnimationFrame(() =>
      window.__claxedoPaintedFrames!({
        sample: (startedAt) => ({ startedAt, taskAt: document.body.dataset.taskAt === undefined ? undefined : Number(document.body.dataset.taskAt) }),
        painted: (frame) => {
          sampled.push(frame)
        },
      }),
    )
  })
  await waitForSampled(page, 20)
  const sampled = await page.evaluate(() => Reflect.get(window, "sampled") as { startedAt: number; taskAt: number | undefined }[])
  expect(sampled.filter((frame) => frame.taskAt !== undefined && frame.taskAt > frame.startedAt)).toEqual([])
  expect(sampled.filter((frame) => frame.taskAt !== undefined).length).toBeGreaterThan(15)
  await page.close()
}, 30_000)

test("a click that lands between a frame's paint and its stamp is not in that frame's sample", async () => {
  const page = await framePage({ workMs: 8 })
  const early: Sampled[] = []
  let landedBeforeStamp = 0
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.evaluate(() => {
      ;(Reflect.get(window, "sampled") as Sampled[]).length = 0
      delete document.body.dataset.pressedAt
    })
    await page.mouse.move(100, 50)
    await page.mouse.down()
    await page.mouse.up()
    await page.waitForFunction(() => (Reflect.get(window, "sampled") as Sampled[]).filter((frame) => frame.pressedAt !== undefined).length >= 2)
    const sampled = await sampledFrames(page)
    const pressedAt = sampled.find((frame) => frame.pressedAt !== undefined)!.pressedAt!
    early.push(...sampled.filter((frame) => frame.pressedAt !== undefined && frame.startedAt < frame.pressedAt))
    landedBeforeStamp += sampled.filter((frame) => frame.pressedAt === undefined && frame.startedAt < pressedAt && frame.paintedAt > pressedAt).length
  }
  expect(early).toEqual([])
  expect(landedBeforeStamp).toBeGreaterThan(0)
  await page.close()
}, 30_000)

test("the clock does not give the app's ResizeObservers another iteration in a frame", async () => {
  const deliveries = async (clock: boolean) => {
    const page = await browser.newPage()
    await page.setContent(`<div><div><div><div style="width:10px;height:10px"></div></div></div></div>`)
    await page.evaluate(installPaintedFrames)
    const delivered = await page.evaluate(async (clock) => {
      const box = document.querySelector<HTMLElement>("div div div div")!
      const grow = () => {
        box.style.width = `${box.getBoundingClientRect().width + 1}px`
      }
      let delivered = 0
      new ResizeObserver(() => {
        delivered += 1
        grow()
      }).observe(box)
      if (clock) window.__claxedoPaintedFrames!({ sample: () => undefined, painted: () => {} })
      await new Promise<void>((resolve) => {
        let frames = 0
        const frame = () => {
          grow()
          frames += 1
          if (frames < 30) requestAnimationFrame(frame)
          else resolve()
        }
        requestAnimationFrame(frame)
      })
      return delivered
    }, clock)
    await page.close()
    return delivered
  }
  expect(await deliveries(true)).toBe(await deliveries(false))
}, 30_000)
