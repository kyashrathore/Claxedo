import { chromium } from "playwright"
import { serve } from "./serve.js"

export const FFMPEG = process.env.FFMPEG ?? "/opt/homebrew/bin/ffmpeg"
export const OUT = new URL("../out/", import.meta.url).pathname

export const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index > -1 ? process.argv[index + 1] : fallback
}

/** Starts the asset server and a headless Chromium; `open(cut)` returns a page whose `film` is ready. */
export const launch = async () => {
  const server = serve(0)
  const browser = await chromium.launch({ args: ["--font-render-hinting=none", "--disable-lcd-text"] })
  const open = async (cut, { scale = 1 } = {}) => {
    const probe = await browser.newPage()
    await probe.goto(`${server.url}?cut=${cut}`)
    await probe.waitForFunction(() => document.documentElement.dataset.ready === "true")
    const size = await probe.evaluate(() => ({ width: window.film.width, height: window.film.height }))
    await probe.close()
    const page = await browser.newPage({ viewport: size, deviceScaleFactor: scale })
    page.on("pageerror", (error) => console.error("page error:", error.message))
    await page.goto(`${server.url}?cut=${cut}`)
    await page.waitForFunction(() => document.documentElement.dataset.ready === "true")
    const meta = await page.evaluate(() => ({ width: window.film.width, height: window.film.height, duration: window.film.duration, fps: window.film.fps }))
    const cdp = await page.context().newCDPSession(page)
    const frame = async (t) => {
      await page.evaluate((time) => window.film.render(time), t)
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true })
      return Buffer.from(data, "base64")
    }
    return { page, meta, frame }
  }
  const close = async () => {
    await browser.close()
    server.stop(true)
  }
  return { open, close, server }
}
