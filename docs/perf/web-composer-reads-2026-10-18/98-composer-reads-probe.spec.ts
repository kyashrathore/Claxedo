import fs from "node:fs"
import type { Page, Request } from "@playwright/test"
import { acpScriptToken, expect, SCRIPTED_ACP_HARNESS, test, UI, type SignedStack } from "../harness"

const DELAY_MS = Number(process.env.PROBE_DELAY_MS ?? 600)
const PROJECTS = Number(process.env.PROBE_PROJECTS ?? 3)
const MODEL = new RegExp(process.env.PROBE_MODEL ?? "GPT|Claude|Sonnet|Opus|Gemini|Haiku|gpt")
const OUT = process.env.PROBE_OUT

type Timed = { readonly url: string; readonly start: number; readonly end: number; readonly bytes: number; readonly decoded: number; readonly origin: string }

function isProbed(request: Request, origin: string) {
  const url = new URL(request.url())
  if (url.origin === origin && !url.pathname.startsWith("/api/")) return false
  if (/\/(wr|cp)\/events/.test(url.pathname)) return false
  return request.resourceType() === "fetch" || request.resourceType() === "xhr"
}

function scrub(text: string) {
  return text.replace(/prj_[\w-]+/g, "prj_…").replace(/ses_[\w-]+/g, "ses_…").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
}

function record(page: Page, origin: string, t0: () => number) {
  const timed: Timed[] = []
  const finished = async (request: Request) => {
    if (!isProbed(request, origin)) return
    const url = new URL(request.url())
    const timing = request.timing()
    if (timing.startTime <= 0 || timing.responseEnd < 0) return
    const sizes = await request.sizes().catch(() => ({ responseBodySize: -1 }))
    const body = await (await request.response())?.body().catch(() => undefined)
    const start = timing.startTime - t0()
    timed.push({ url: scrub(`${url.pathname}${url.search}`), origin: url.origin === origin ? "app" : url.host, start, end: start + timing.responseEnd, bytes: sizes.responseBodySize, decoded: body?.length ?? -1 })
  }
  page.on("requestfinished", finished)
  page.on("requestfailed", finished)
  return timed
}

async function seed(signed: SignedStack) {
  await signed.local.acp.write("hello", { steps: [{ kind: "text", text: "Hello from the agent" }] })
  for (let index = 0; index < PROJECTS; index++) {
    const workspace = await signed.makeWorkspace(`p${index}`, `Project ${index}`)
    const session = await signed.owner.api.createSession(workspace.directory, { title: `Session ${index}`, harness: SCRIPTED_ACP_HARNESS })
    await signed.owner.api.prompt(workspace.directory, session.id, `Say hello. ${acpScriptToken("hello")}`)
  }
}

test("98 composer reads probe: the requests and waves until the composer's model chip names a model", async ({ signed, page }, testInfo) => {
  test.setTimeout(240_000)
  await seed(signed)
  await page.route((url) => url.pathname.startsWith("/api/") || url.origin !== signed.url, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS))
    await route.continue()
  })
  await signed.signIn(page, signed.owner)
  await expect(page.getByRole("textbox", { name: UI.composer })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole("button", { name: /^Select harness and model/ })).toContainText(MODEL, { timeout: 60_000 })

  let t0 = 0
  const requests = record(page, signed.url, () => t0)
  await page.addInitScript(() => {
    const log: Array<{ t: number; text: string }> = []
    Object.assign(window, { __chipLog: log })
    let last = ""
    const sample = () => {
      const chip = document.querySelector('[aria-label^="Select harness and model"]')
      const text = chip ? `${chip.textContent?.trim() ?? ""} | ${chip.getAttribute("data-readiness")} | submit=${chip.getAttribute("data-ready-for-submit")} | ${chip.getAttribute("data-provider") ?? ""}/${chip.getAttribute("data-model") ?? ""}` : ""
      if (text !== last) {
        last = text
        log.push({ t: performance.timeOrigin + performance.now(), text })
      }
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
  t0 = Date.now()
  await page.reload()
  await expect(page.getByRole("textbox", { name: UI.composer })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole("button", { name: /^Select harness and model/ })).toContainText(MODEL, { timeout: 60_000 })
  await expect(page.locator('[data-action="prompt-harness-model"][data-readiness="ready"][data-ready-for-submit="true"]')).toBeVisible({ timeout: 60_000 })
  const chipAt = Date.now() - t0
  await page.waitForTimeout(3 * DELAY_MS + 1000)
  const chipLog = (await page.evaluate(() => (window as unknown as { __chipLog: Array<{ t: number; text: string }> }).__chipLog)).map((entry) => ({ t: Math.round(entry.t - t0), text: entry.text }))
  const summary = { delayMs: DELAY_MS, projects: PROJECTS, chipAt, chipLog, requests }
  const text = JSON.stringify(summary, null, 2)
  await testInfo.attach("composer-reads", { body: text, contentType: "application/json" })
  if (OUT) fs.writeFileSync(OUT, text)
})
