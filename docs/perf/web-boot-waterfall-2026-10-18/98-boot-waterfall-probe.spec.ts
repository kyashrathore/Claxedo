import fs from "node:fs"
import type { Page, Request } from "@playwright/test"
import { acpScriptToken, expect, SCRIPTED_ACP_HARNESS, test, UI, type SignedStack } from "../harness"

const DELAY_MS = Number(process.env.BOOT_PROBE_DELAY_MS ?? 600)
const PROJECTS = Number(process.env.BOOT_PROBE_PROJECTS ?? 5)
const OUT = process.env.BOOT_PROBE_OUT

type Timed = { readonly url: string; readonly start: number; readonly end: number }

function isApi(url: URL, origin: string) {
  return url.origin === origin && url.pathname.startsWith("/api/") && !/^\/api\/(wr|cp)\/events/.test(url.pathname)
}

function recordApi(page: Page, origin: string, t0: () => number) {
  const timed: Timed[] = []
  const finished = (request: Request) => {
    const url = new URL(request.url())
    if (!isApi(url, origin)) return
    const timing = request.timing()
    if (timing.startTime <= 0 || timing.responseEnd < 0) return
    const start = timing.startTime - t0()
    timed.push({ url: `${url.pathname}${url.search}`.replace(/prj_[\w-]+/g, "prj_…").replace(/ses_[\w-]+/g, "ses_…"), start, end: start + timing.responseEnd })
  }
  page.on("requestfinished", finished)
  page.on("requestfailed", finished)
  return timed
}

function waves(requests: readonly Timed[]) {
  const sorted = [...requests].sort((a, b) => a.start - b.start)
  const depth = new Map<Timed, number>()
  for (const request of sorted) {
    const before = sorted.filter((other) => other !== request && other.end <= request.start + 5)
    depth.set(request, 1 + Math.max(0, ...before.map((other) => depth.get(other) ?? 0)))
  }
  return { sorted, depth, max: Math.max(0, ...depth.values()) }
}

function report(label: string, requests: readonly Timed[], rowsAt: number) {
  const { sorted, depth, max } = waves(requests)
  const lines = sorted.map((request) => `${String(Math.round(request.start)).padStart(6)}→${String(Math.round(request.end)).padEnd(6)} w${depth.get(request)}  ${request.url}`)
  const summary = `${label}: ${requests.length} API requests, ${max} dependent wave(s), rail rows visible at ${Math.round(rowsAt)} ms (delay ${DELAY_MS} ms per API request)`
  return `${summary}\n${lines.join("\n")}`
}

async function seed(signed: SignedStack) {
  await signed.local.acp.write("hello", { steps: [{ kind: "text", text: "Hello from the agent" }] })
  for (let index = 0; index < PROJECTS; index++) {
    const workspace = await signed.makeWorkspace(`p${index}`, `Project ${index}`)
    const session = await signed.owner.api.createSession(workspace.directory, { title: `Session ${index}`, harness: SCRIPTED_ACP_HARNESS })
    await signed.owner.api.prompt(workspace.directory, session.id, `Say hello. ${acpScriptToken("hello")}`)
  }
}

async function rowsVisible(page: Page) {
  await expect(page.getByTestId("rail-sidebar-session-row")).toHaveCount(PROJECTS, { timeout: 60_000 })
  await expect(page.getByRole("textbox", { name: UI.composer })).toBeVisible()
}

test("98 boot waterfall probe: the signed boot's API requests and dependent waves until the rail is filled", async ({ signed, page }, testInfo) => {
  test.setTimeout(240_000)
  await seed(signed)
  await page.route((url) => isApi(url, signed.url), async (route) => {
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS))
    await route.continue()
  })
  await signed.signIn(page, signed.owner)
  await rowsVisible(page)

  let t0 = 0
  const requests = recordApi(page, signed.url, () => t0)
  t0 = Date.now()
  await page.reload()
  await rowsVisible(page)
  const rowsAt = Date.now() - t0
  await page.waitForTimeout(2 * DELAY_MS + 500)
  const text = report("warm reload", requests, rowsAt)
  console.log(text)
  await testInfo.attach("boot-waterfall", { body: text, contentType: "text/plain" })
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ delayMs: DELAY_MS, projects: PROJECTS, rowsAt, requests, text }, null, 2))
})
