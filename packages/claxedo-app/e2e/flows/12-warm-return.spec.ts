import { execFileSync } from "node:child_process"
import type { Browser, CDPSession, Page } from "@playwright/test"
import { acpScriptToken, apiRequests, expect, SCRIPTED_ACP_HARNESS, sessionRoute, test, UI, type AcpStep, type ClaxedoApi, type Stack } from "../harness"
import { installPaintedFrames } from "../../perf-harness/src/browser/painted-frames"
import { readArrivals, recordSwitchFrames, switchReport } from "./12-switch-paint.frames"

type ReturnWork = { readonly revealedMs: number; readonly revealFrame: number; readonly settledMs: number; readonly longestFrameMs: number; readonly addedElements: number; readonly navElements: number; readonly navShown: boolean; readonly fromEnd: number; readonly reads: readonly string[]; readonly latestTurnMs: number; readonly outlineMs: number; readonly metrics: Record<string, number> }


const METRICS = ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration", "LayoutCount", "RecalcStyleCount"] as const

type TurnBytes = { readonly tool: number; readonly reply: number }

async function seed(stack: Stack, api: ClaxedoApi, directory: string, title: string, turns: number, bytes: TurnBytes, last: TurnBytes = bytes) {
  const session = await api.createSession(directory, { title, harness: SCRIPTED_ACP_HARNESS })
  const line = (turn: number, index: number) => `${title} turn ${turn} line ${index}: the fixture reads a file and replies with markdown.`
  const lines = (turn: number, size: number) => Array.from({ length: Math.max(1, Math.ceil(size / 80)) }, (_, index) => line(turn, index)).join("\n")
  for (let turn = 1; turn <= turns; turn += 1) {
    const size = turn === turns ? last : bytes
    const steps: AcpStep[] = [
      { kind: "tool", tool: "read", title: `Read part-${turn}.md`, locations: [{ path: `${directory}/part-${turn}.md` }], text: lines(turn, size.tool) },
      { kind: "text", text: `## ${title} reply ${turn}\n\n${lines(turn, size.reply)}` },
    ]
    const script = `warm-${title.replace(/\W+/g, "-")}-${turn}`
    await stack.acp.write(script, { steps })
    await api.prompt(directory, session.id, `${title} turn ${turn}: continue. ${acpScriptToken(script)}`)
  }
  return session
}

async function metrics(cdp: CDPSession) {
  const { metrics: rows } = (await cdp.send("Performance.getMetrics")) as { metrics: { name: string; value: number }[] }
  return Object.fromEntries(rows.filter((row) => (METRICS as readonly string[]).includes(row.name)).map((row) => [row.name, row.value]))
}

async function countAddedElements(app: Page) {
  await app.evaluate(() => {
    const counter = { added: 0, nav: 0 }
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue
          const size = 1 + node.getElementsByTagName("*").length
          const rail = '[data-component="message-nav"]'
          const inRail = node.closest(rail) ? size : [...node.querySelectorAll(rail)].reduce((sum, nav) => sum + 1 + nav.getElementsByTagName("*").length, 0)
          counter.nav += inRail
          counter.added += size - inRail
        }
      }
    }).observe(document.body, { subtree: true, childList: true })
    Reflect.set(window, "__claxedoAddedElements", counter)
  })
  return () => app.evaluate(() => Reflect.get(window, "__claxedoAddedElements") as { added: number; nav: number })
}

async function warmReturn(app: Page, cdp: CDPSession, settled: () => Promise<string[]>, session: { readonly id: string; readonly title: string }): Promise<ReturnWork> {
  const added = await countAddedElements(app)
  const before = await metrics(cdp)
  const frames = await recordSwitchFrames(app, { targetId: session.id, quietFrames: 30 })
  await app.getByRole("navigation", { name: UI.rail }).getByRole("button", { name: session.title, exact: true }).click()
  const seen = switchReport(await frames(), session.id)
  const after = await metrics(cdp)
  const counted = await added()
  const reads = await settled()
  const last = (await frames()).at(-1)?.panes[0]
  const arrivals = await readArrivals(app, session.id)
  return {
    revealedMs: seen.revealedAt?.ms ?? -1,
    revealFrame: seen.revealedAt?.frame ?? -1,
    settledMs: seen.settledAt?.ms ?? seen.revealedAt?.ms ?? -1,
    longestFrameMs: seen.longestFrameMs,
    addedElements: counted.added,
    navElements: counted.nav,
    navShown: last?.nav ?? false,
    fromEnd: last?.fromEnd ?? -1,
    reads,
    latestTurnMs: arrivals.find((read) => read.view.startsWith("latest-"))?.arrivedMs ?? -1,
    outlineMs: arrivals.find((read) => read.view === "outline")?.arrivedMs ?? -1,
    metrics: Object.fromEntries(METRICS.map((name) => [name, Math.round(((after[name] ?? 0) - (before[name] ?? 0)) * (name.endsWith("Duration") ? 1000 : 1))])),
  }
}

test.skip(({ isMobile }) => isMobile, "the warm return is measured at desktop width")

function transcriptBytes(app: Page) {
  const reads: { readonly sessionId: string; readonly view: string | null; readonly bytes: number }[] = []
  app.on("response", (response) => {
    const url = new URL(response.url())
    const match = /\/session\/([^/]+)\/(message|outline)$/.exec(url.pathname)
    if (!match || response.request().method() !== "GET") return
    const view = match[2] === "outline" ? "outline" : url.searchParams.get("view")
    void response.body().then((body) => reads.push({ sessionId: decodeURIComponent(match[1]), view, bytes: body.length }))
  })
  return reads
}

async function heapAfterCollection(cdp: CDPSession) {
  await cdp.send("HeapProfiler.collectGarbage")
  const { usedSize } = (await cdp.send("Runtime.getHeapUsage")) as { usedSize: number }
  return usedSize
}

async function rendererRssBytes(browser: Browser) {
  const cdp = await browser.newBrowserCDPSession()
  const { processInfo } = (await cdp.send("SystemInfo.getProcessInfo")) as { processInfo: { type: string; id: number }[] }
  await cdp.detach()
  const renderers = processInfo.filter((process) => process.type === "renderer").map((process) => process.id)
  const rss = execFileSync("ps", ["-o", "rss=", "-p", renderers.join(",")], { encoding: "utf8" })
  return rss.trim().split(/\s+/).reduce((sum, kib) => sum + Number(kib) * 1024, 0)
}

test("12 a return after a walk past the open-session cache does the same work for a small and a large session", async ({ stack, api, app }, info) => {
  test.setTimeout(600_000)
  const turn = { tool: 400, reply: 800 }
  const home = await stack.daemon.makeWorkspace("walk-home", "Walk home")
  const anchor = await seed(stack, api, home.directory, "Anchor", 2, turn)
  const walk: { readonly label: "small" | "large"; readonly session: Awaited<ReturnType<typeof seed>>; readonly last: string }[] = []
  for (let index = 1; index <= 5; index += 1) {
    const workspace = await stack.daemon.makeWorkspace(`walk-${index}`, `Walk ${index}`)
    walk.push({ label: "small", session: await seed(stack, api, workspace.directory, `Small ${index}`, 4, turn), last: `Small ${index} reply 4` })
    walk.push({ label: "large", session: await seed(stack, api, workspace.directory, `Large ${index}`, 40, { tool: 40_000, reply: 10_000 }, turn), last: `Large ${index} reply 40` })
  }
  const reads = transcriptBytes(app)
  await app.addInitScript(installPaintedFrames)
  await app.goto(`${stack.url}${sessionRoute(home.id, anchor.id)}`)
  await expect(app.getByText("Anchor reply 2").first()).toBeVisible()
  const rail = app.getByRole("navigation", { name: UI.rail })
  const settled = apiRequests(app, stack.url)
  await settled()
  const cdp = await app.context().newCDPSession(app)
  await cdp.send("Performance.enable")
  type Work = ReturnWork & { readonly transcriptBytes: number; readonly olderPageReads: number; readonly outlineBytes: number }
  const runs: Record<string, Work[]> = { small: [], large: [], "first small": [], "first large": [], "again small": [], "again large": [] }
  const heaps: number[] = []
  const rss: number[] = [await rendererRssBytes(app.context().browser()!)]
  for (const pass of ["first", "return", "again"] as const) {
    for (const step of walk) {
      reads.length = 0
      const work = await warmReturn(app, cdp, settled, step.session)
      await expect(app.getByText(step.last).first()).toBeVisible()
      const nav = app.getByRole("button", { name: `${step.label === "large" ? 40 : 4}. New message`, exact: true })
      if (step.label === "large") await expect(nav, `the rail lists every turn of ${step.session.title} on its ${pass} visit, with no scroll`).toBeVisible()
      else await expect(nav, "four turns show no rail").toHaveCount(0)
      runs[pass === "return" ? step.label : `${pass} ${step.label}`].push({
        ...work,
        transcriptBytes: reads.filter((read) => read.view !== "outline").reduce((sum, read) => sum + read.bytes, 0),
        olderPageReads: reads.filter((read) => read.view === null).length,
        outlineBytes: reads.filter((read) => read.view === "outline").reduce((sum, read) => sum + read.bytes, 0),
      })
    }
    heaps.push(await heapAfterCollection(cdp))
    rss.push(await rendererRssBytes(app.context().browser()!))
  }
  await info.attach("returns", { body: JSON.stringify({ runs, heaps, rss }, null, 1), contentType: "application/json" })
  const median = (label: string, pick: (work: Work) => number) => runs[label].map(pick).sort((a, b) => a - b)[2]
  for (const label of Object.keys(runs)) {
    expect.soft(runs[label].map((work) => work.olderPageReads), `older-page reads on ${label} visits, which no visit makes without a scroll, pull or pick`).toEqual([0, 0, 0, 0, 0])
    expect.soft(runs[label].map((work) => work.fromEnd <= 2), `${label} visits stay bottom-anchored`).toEqual([true, true, true, true, true])
  }
  for (const pass of ["first", "return"] as const) {
    const large = pass === "return" ? "large" : "first large"
    const small = pass === "return" ? "small" : "first small"
    expect.soft(median(large, (work) => work.transcriptBytes), `transcript bytes a ${pass} visit to a large session reads, against a small one's (${median(small, (work) => work.transcriptBytes)})`).toBeLessThanOrEqual(median(small, (work) => work.transcriptBytes) * 1.5 + 2048)
    expect.soft(median(large, (work) => work.addedElements), `elements a ${pass} visit to a large session adds, against a small one's`).toBeLessThanOrEqual(median(small, (work) => work.addedElements) * 1.5 + 200)
    expect.soft(median(large, (work) => work.outlineBytes), `outline bytes a ${pass} visit to a large session reads`).toBeLessThanOrEqual(40 * 512)
  }
  expect.soft(runs.large.map((work) => work.outlineBytes), "a return to a kept session reads no outline").toEqual([0, 0, 0, 0, 0])
  expect.soft(heaps[2], `JS heap after the third walk (after the second: ${heaps[1]}, the first: ${heaps[0]})`).toBeLessThanOrEqual(heaps[1] * 1.1)
})
