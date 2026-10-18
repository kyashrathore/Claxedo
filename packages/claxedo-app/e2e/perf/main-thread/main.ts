import { chromium } from "@playwright/test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ClaxedoApi } from "../../harness/api"
import { ensureAppBuilt } from "../../harness/app"
import { prepareHarness } from "../../harness/global-setup"
import { startStack } from "../../harness/stack"
import { startAppOrigin } from "../origin"
import { readOptions, runOrder } from "../options"
import { createSourceMapper } from "../panel/trace"
import { bumpShort, seedFixture } from "./fixture"
import { report } from "./report"
import { runOnce, type ScenarioRow } from "./scenarios"

const argv = process.argv.slice(2)
const flag = (name: string) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)

const load = () => os.loadavg().map((value) => value.toFixed(2)).join(" ")

function line(row: ScenarioRow) {
  const ready = row.analysis.ready
  const tail = row.analysis.tail
  return `[${row.variant} #${row.run}] ${row.scenario}: ready ${row.readyMs.toFixed(0)}${row.railReadyMs === undefined ? "" : ` rail ${row.railReadyMs.toFixed(0)}`} busy ${ready.busyMs.toFixed(0)} cpu ${ready.cpuMs.toFixed(0)} tbt ${ready.tbtMs.toFixed(0)} long ${ready.longTasks}/${ready.longestMs.toFixed(0)} style ${ready.styleN}/${ready.styleMs.toFixed(0)} layout ${ready.layoutN}/${ready.layoutMs.toFixed(0)} forced ${ready.forcedN} paint ${ready.paintMs.toFixed(0)} | tail busy ${tail.busyMs.toFixed(0)} tbt ${tail.tbtMs.toFixed(0)} long ${tail.longTasks}`
}

async function main() {
  const options = readOptions(argv)
  const scenarios = (flag("scenarios") ?? "open:1m,open:8m,return:1m,return:short,stream").split(",")
  const longMiB = (flag("long") ?? "1,8").split(",").map(Number)
  const censusRuns = argv.includes("--census") ? 1 : 0
  const traceDir = argv.includes("--keep-traces") ? path.join(options.out, "traces") : undefined
  await fs.mkdir(traceDir ?? options.out, { recursive: true })
  await prepareHarness()
  const stack = await startStack({ label: "perf-main-thread" })
  const closers: (() => Promise<void>)[] = []
  try {
    const api = new ClaxedoApi(stack.url)
    const order = runOrder(options)
    const fixture = await seedFixture(stack, api, { railSessions: Number(flag("rail") ?? "36"), shortSessions: order.length + censusRuns * options.variants.length, longMiB })
    const origins = new Map<string, { url: string; distDir: string }>()
    for (const variant of options.variants) {
      const distDir = variant.dist ?? (await ensureAppBuilt({ serverUrl: `http://127.0.0.1:${variant.port}`, outDir: path.join(import.meta.dirname, "..", "dist", variant.name) })).distDir
      const origin = await startAppOrigin({ port: variant.port, distDir, daemonUrl: stack.url })
      closers.push(() => origin.close())
      origins.set(variant.name, { url: origin.url, distDir })
    }
    const browser = await chromium.launch({ channel: "chromium" })
    closers.push(() => browser.close())
    const rows: ScenarioRow[] = []
    const census: ScenarioRow[] = []
    const plan = [...order.map((variant) => ({ variant, census: false })), ...Array.from({ length: censusRuns }, () => options.variants.map((variant) => ({ variant, census: true }))).flat()]
    for (const [index, step] of plan.entries()) {
      const origin = origins.get(step.variant.name)
      const seeded = fixture.shorts[index]
      if (!origin || !seeded) throw new Error(`run ${index} has no origin or session`)
      const short = await bumpShort(stack, api, fixture, seeded, index)
      console.log(`[main-thread] run ${index} ${step.variant.name}${step.census ? " census" : ""}, load ${load()}`)
      const input = { browser, originUrl: origin.url, variant: step.variant.name, run: index, short, fixture, api, stack, throttle: options.throttle, census: step.census, mapper: createSourceMapper(origin.distDir), traceDir: index < options.variants.length ? traceDir : undefined, out: options.out, onRow: (row: ScenarioRow) => console.log(line(row)) }
      const result = await runOnce(input, scenarios)
      ;(step.census ? census : rows).push(...result)
      await fs.writeFile(path.join(options.out, `${options.label}-rows.json`), JSON.stringify({ fixture: { long: fixture.long, rail: fixture.railSessions }, rows, census }, null, 1))
    }
    const markdown = report(rows, census)
    await fs.writeFile(path.join(options.out, `${options.label}-report.md`), markdown)
    console.log(markdown)
  } finally {
    for (const close of closers.reverse()) await close()
    await stack.close()
  }
}

await main()
