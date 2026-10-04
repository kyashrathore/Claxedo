import { chromium, type CDPSession, type Page } from "@playwright/test"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { installPaintedFrames } from "../../harness/painted-frames"
import { ClaxedoApi } from "../../harness/api"
import { appDistDir, ensureAppBuilt } from "../../harness/app"
import { prepareHarness } from "../../harness/global-setup"
import { startStack, type Stack } from "../../harness/stack"
import { startAppOrigin, type AppOrigin } from "../origin"
import { createSourceMapper } from "./trace"
import { OUT, Runner } from "./runner"
import { walk } from "./walk"
import { benchmarkWorkspace, largeWorkspace, type Workspace } from "./workspaces"

const load = () => os.loadavg().map((value) => value.toFixed(2)).join(" ")

type VariantOrigin = AppOrigin & { readonly name: string; readonly distDir: string }

async function startVariants(stack: Stack): Promise<{ readonly list: readonly VariantOrigin[]; readonly rounds: number }> {
  const spec = process.env.PANEL_VARIANTS
  if (!spec) return { list: [{ name: "app", distDir: appDistDir(), url: stack.url, close: async () => undefined }], rounds: 1 }
  const list: VariantOrigin[] = []
  for (const [index, entry] of spec.split(",").entries()) {
    const [name, dist, declaredPort] = entry.split(":") as [string, string | undefined, string | undefined]
    const port = declaredPort ? Number(declaredPort) : 47380 + index
    const serverUrl = `http://127.0.0.1:${port}`
    const distDir = dist ?? (await ensureAppBuilt({ serverUrl, outDir: path.join(appDistDir(), "..", `dist-e2e-${name}`) })).distDir
    const origin = await startAppOrigin({ port, distDir, daemonUrl: stack.url })
    list.push({ ...origin, name, distDir })
    console.log(`[panel] variant ${name} at ${origin.url} from ${distDir}`)
  }
  return { list, rounds: Number(process.env.PANEL_ROUNDS ?? "2") }
}

function daemonCpu(pid: number | undefined) {
  if (pid === undefined) return "?"
  return execFileSync("ps", ["-p", String(pid), "-o", "cputime="], { encoding: "utf8" }).trim()
}

function daemonEnv() {
  const spec = process.env.PANEL_DAEMON_ENV
  if (!spec) return undefined
  return Object.fromEntries(spec.split(",").map((entry) => entry.split("=") as [string, string]))
}

const REGIONS: Record<string, string> = {
  navigator: "[data-testid='workspace-navigator-overlay']",
  tab: "[data-testid='workspace-panel-body'] #review-panel",
  session: "[data-testid='session-page-root']",
  rail: "[data-testid='session-rail'], nav[aria-label]",
}

function census(page: Page) {
  return page.evaluate((regions) => {
    const count = (root: ParentNode) => root.querySelectorAll("*").length
    const deep = (root: ParentNode): number => [...root.querySelectorAll("*")].reduce((sum, node) => sum + (node.shadowRoot ? 1 + deep(node.shadowRoot) : 1), 0)
    const out: Record<string, string> = { body: `${count(document.body)}/${deep(document.body)}` }
    for (const [name, selector] of Object.entries(regions)) {
      const roots = [...document.querySelectorAll(selector)]
      out[name] = roots.length ? `${roots.map((root) => count(root)).reduce((a, b) => a + b, 0)}/${roots.map((root) => deep(root)).reduce((a, b) => a + b, 0)}` : "-"
    }
    return Object.entries(out).map(([name, value]) => `${name} ${value}`).join(" ")
  }, REGIONS)
}

async function memory(page: Page, cdp: CDPSession, stack: Stack, label: string) {
  await cdp.send("HeapProfiler.collectGarbage")
  const { metrics } = (await cdp.send("Performance.getMetrics")) as { metrics: { name: string; value: number }[] }
  const pick = (name: string) => metrics.find((metric) => metric.name === name)?.value ?? 0
  console.log(`[memory] ${label}: nodes ${pick("Nodes")} listeners ${pick("JSEventListeners")} heap ${(pick("JSHeapUsedSize") / 1048576).toFixed(1)} MiB / ${(pick("JSHeapTotalSize") / 1048576).toFixed(1)} MiB, daemon cpu ${daemonCpu(stack.daemon.pid())}; light/deep elements: ${await census(page)}`)
}

async function main() {
  await fs.mkdir(OUT, { recursive: true })
  console.log(`[panel] out ${OUT}, load ${load()}, runs ${process.env.PANEL_RUNS ?? "5"}`)
  await prepareHarness()
  const stack = await startStack({ label: "panel-switch", daemonEnv: daemonEnv() })
  console.log(`[panel] daemon env ${JSON.stringify(daemonEnv() ?? {})}`)
  try {
    const api = new ClaxedoApi(stack.url)
    const wanted = (process.env.PANEL_WORKSPACES ?? "bench,large").split(",")
    const workspaces: Workspace[] = []
    if (wanted.includes("bench")) workspaces.push(await benchmarkWorkspace(stack, api))
    if (wanted.includes("large")) workspaces.push(await largeWorkspace(stack, api))
    console.log(`[panel] workspaces ${workspaces.map((workspace) => `${workspace.name}(${workspace.files.length} files, ${workspace.changed.length} changed)`).join(", ")}`)
    const browser = await chromium.launch({ channel: "chromium", headless: process.env.PANEL_HEADED !== "1" })
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light", locale: "en-US", timezoneId: "UTC" })
      await context.addInitScript(installPaintedFrames)
      const page = await context.newPage()
      page.on("pageerror", (error) => console.log(`[page error] ${error.message}\n${error.stack ?? ""}`))
      page.on("console", (message) => {
        if (message.type() === "error" || message.type() === "warning") console.log(`[console ${message.type()}] ${message.text().slice(0, 400)}`)
      })
      const runner = new Runner(page, createSourceMapper(appDistDir()))
      const cdp = await context.newCDPSession(page)
      await cdp.send("Performance.enable")
      const variants = await startVariants(stack)
      try {
        for (let round = 0; round < variants.rounds; round += 1) {
          const order = round % 2 === 0 ? variants.list : [...variants.list].reverse()
          for (const variant of order) {
            runner.useVariant(variant.name, variant.distDir)
            for (const workspace of workspaces) {
              await walk(page, runner, workspace, variant.url, (label) => memory(page, cdp, stack, `${variant.name} ${workspace.name} round ${round}: ${label}`))
              await runner.flush()
            }
          }
        }
      } finally {
        for (const variant of variants.list) await variant.close()
      }
      await memory(page, cdp, stack, "end")
    } finally {
      await browser.close()
    }
  } finally {
    await stack.close()
  }
}

await main()
