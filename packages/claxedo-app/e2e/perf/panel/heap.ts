import { chromium, type CDPSession, type Page } from "@playwright/test"
import fs from "node:fs/promises"
import path from "node:path"
import { ClaxedoApi } from "../../harness/api"
import { prepareHarness } from "../../harness/global-setup"
import { startStack } from "../../harness/stack"
import { sessionRoute } from "../../harness/ui-names"
import { detachedNodes, firstOwner, loadGraph, shortestPath, tally } from "./heap-retainers"
import { ensureNavigator, settle } from "./page-actions"
import { OUT } from "./runner"
import { benchmarkWorkspace } from "./workspaces"

const SWITCHES = Number(process.env.PANEL_HEAP_SWITCHES ?? "1")

async function snapshot(cdp: CDPSession, file: string) {
  const chunks: string[] = []
  const onChunk = (event: { chunk: string }) => chunks.push(event.chunk)
  cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk)
  await cdp.send("HeapProfiler.collectGarbage")
  await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false })
  cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk)
  await fs.writeFile(file, chunks.join(""))
  console.log(`[heap] DOM nodes after the ${path.basename(file)} snapshot ${await domNodes(cdp)}`)
  return file
}

async function domNodes(cdp: CDPSession) {
  const { metrics } = (await cdp.send("Performance.getMetrics")) as { metrics: { name: string; value: number }[] }
  return metrics.find((metric) => metric.name === "Nodes")?.value ?? 0
}

async function report(file: string, sample: number) {
  const graph = loadGraph(JSON.parse(await fs.readFile(file, "utf8")))
  const detached = detachedNodes(graph)
  const size = detached.reduce((sum, node) => sum + graph.selfSize(node), 0)
  const tree = detached.filter((node) => /data-file-tree-row=|data-file-tree-shell-ready|Search files/.test(graph.name(node)))
  console.log(`[heap] ${path.basename(file)}: ${detached.length} detached nodes, ${(size / 1024).toFixed(1)} KiB self, ${tree.length} from a mounted files navigator (${tree.map((node) => graph.name(node).slice(0, 60)).join(" | ")}); by name: ${tally(detached.map((node) => graph.name(node))).slice(0, 8).map(([name, count]) => `${name} ${count}`).join(", ")}`)
  const step = Math.max(1, Math.floor(detached.length / sample))
  const paths = detached.filter((_, index) => index % step === 0).slice(0, sample).map((node) => shortestPath(graph, node))
  console.log(`[heap] owners of ${paths.length} sampled detached nodes: ${tally(paths.map(firstOwner)).slice(0, 6).map(([owner, count]) => `${count}x ${owner}`).join(" | ")}`)
  for (const found of paths.slice(0, 3)) console.log(`[heap] path: ${found.map((step) => `${step.name}${step.edge ? ` <-[${step.edge}]-` : ""}`).join(" ")}`)
}

async function switchNavigator(page: Page, cdp: CDPSession, label: string) {
  await ensureNavigator(page, "changes")
  await page.waitForFunction(() => document.querySelector("[data-testid='workspace-files-navigator'][data-mode='files']") === null, undefined, { polling: "raf" })
  await settle(page)
  const before = await domNodes(cdp)
  await cdp.send("HeapProfiler.collectGarbage")
  console.log(`[heap] ${label}: files hidden, DOM nodes ${before} before GC, ${await domNodes(cdp)} after`)
}

async function main() {
  await fs.mkdir(OUT, { recursive: true })
  await prepareHarness()
  const stack = await startStack({ label: "panel-heap" })
  try {
    const workspace = await benchmarkWorkspace(stack, new ClaxedoApi(stack.url))
    const browser = await chromium.launch({ channel: "chromium", headless: true })
    try {
      const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })).newPage()
      page.on("pageerror", (error) => console.log(`[page error] ${error.message}`))
      const cdp = await page.context().newCDPSession(page)
      await cdp.send("Performance.enable")
      await cdp.send("HeapProfiler.enable")
      await page.goto(`${stack.url}${sessionRoute(workspace.id, workspace.sessions[0])}`)
      await page.locator("[data-component='prompt-input']").waitFor({ timeout: 60_000 })
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1500)))
      await ensureNavigator(page, "files")
      await page.locator("[data-file-tree-path]").first().waitFor()
      await settle(page)
      console.log(`[heap] files mounted, DOM nodes ${await domNodes(cdp)}`)
      await report(await snapshot(cdp, path.join(OUT, "mounted.heapsnapshot")), 30)
      await switchNavigator(page, cdp, "after 1 unmount")
      await report(await snapshot(cdp, path.join(OUT, "unmounted.heapsnapshot")), 200)
      for (let run = 1; run < SWITCHES; run += 1) {
        await ensureNavigator(page, "files")
        await switchNavigator(page, cdp, `after ${run + 1} unmounts`)
      }
      if (SWITCHES > 1) await report(await snapshot(cdp, path.join(OUT, `unmounted-${SWITCHES}.heapsnapshot`)), 200)
    } finally {
      await browser.close()
    }
  } finally {
    await stack.close()
  }
}

await main()
