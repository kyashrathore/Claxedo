import { chromium, type Browser, type Page } from "@playwright/test"
import fs from "node:fs/promises"
import path from "node:path"
import { ensureAppBuilt, type AppChoice } from "../harness/app"
import { prepareHarness } from "../harness/global-setup"
import { releasePort, reservePort } from "../harness/ports"
import { startStack, type Stack } from "../harness/stack"
import { compareShots } from "./compare"
import { startAppOrigin, type AppOrigin } from "./origin"
import { writeReport, type ShotResult } from "./report"
import { SCREENS, SIZES, type Screen, type ScreenContext, type Size } from "./screens"
import { prepareFreshStack, seedStack, type SeedData } from "./seed"
import { settledShot } from "./settle"

const PARITY_DIR = import.meta.dirname
const OUT_DIR = path.join(PARITY_DIR, "report")
const APPS: readonly AppChoice[] = ["v1", "v2"]
const STEP_TIMEOUT_MS = 5_000

type Selection = { screens?: ReadonlySet<string>; sizes: readonly Size[] }
type Origins = Record<AppChoice, AppOrigin>
type Shot = { png: Buffer; note?: string }

function selection(argv: string[]): Selection {
  const value = (name: string) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
  const screens = value("screens")?.split(",").filter(Boolean)
  const sizes = value("sizes")?.split(",")
  return { screens: screens ? new Set(screens) : undefined, sizes: sizes ? SIZES.filter((size) => sizes.includes(size.name)) : SIZES }
}

function firstLine(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0]
}

async function startOrigins(daemonUrl: string, closers: (() => Promise<void>)[]): Promise<Origins> {
  const started: Partial<Origins> = {}
  for (const app of APPS) {
    const port = await reservePort()
    closers.push(async () => releasePort(port))
    const build = await ensureAppBuilt(app, { serverUrl: `http://127.0.0.1:${port}`, outDir: path.join(PARITY_DIR, "dist", app) })
    console.log(`[parity] ${app} ${build.built ? `built in ${build.ms} ms` : "build is current"}`)
    const origin = await startAppOrigin({ port, distDir: build.distDir, daemonUrl })
    closers.push(() => origin.close())
    started[app] = origin
  }
  if (!started.v1 || !started.v2) throw new Error("both apps need an origin")
  return { v1: started.v1, v2: started.v2 }
}

async function shoot(browser: Browser, url: string, screen: Screen, context: Omit<ScreenContext, "page">): Promise<Shot> {
  const { size } = context
  const browserContext = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: 1,
    isMobile: size.touch,
    hasTouch: size.touch,
    reducedMotion: "reduce",
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "UTC",
  })
  browserContext.setDefaultTimeout(STEP_TIMEOUT_MS)
  try {
    const page = await browserContext.newPage()
    const screenContext = { ...context, page }
    await page.goto(new URL(screen.path(screenContext), url).toString())
    await settledShot(page)
    const note = screen.steps ? await screen.steps(screenContext).then(() => undefined, (error: unknown) => `step failed: ${firstLine(error)}`) : undefined
    return { png: await settledShot(page), note }
  } finally {
    await browserContext.close()
  }
}

async function captureScreen(browser: Browser, diffPage: Page, origins: Origins, screen: Screen, size: Size, seed: SeedData | undefined) {
  const v1 = await shoot(browser, origins.v1.url, screen, { app: "v1", seed, size })
  const v2 = await shoot(browser, origins.v2.url, screen, { app: "v2", seed, size })
  const comparison = await compareShots(diffPage, v1.png, v2.png)
  const base = `${screen.id}-${size.name}`
  const files = { v1: `${base}-v1.png`, v2: `${base}-v2.png`, side: `${base}-side.png` }
  await Promise.all([
    fs.writeFile(path.join(OUT_DIR, files.v1), v1.png),
    fs.writeFile(path.join(OUT_DIR, files.v2), v2.png),
    fs.writeFile(path.join(OUT_DIR, files.side), comparison.side),
  ])
  const result: ShotResult = { screen: screen.id, size: size.name, changedRatio: comparison.changedRatio, notes: { v1: v1.note, v2: v2.note }, files }
  console.log(`[parity] ${base}: ${(comparison.changedRatio * 100).toFixed(2)}%${v1.note ? ` · v1 ${v1.note}` : ""}${v2.note ? ` · v2 ${v2.note}` : ""}`)
  return result
}

function chosenScreens(phase: Screen["phase"], chosen: Selection) {
  return SCREENS.filter((screen) => screen.phase === phase && (!chosen.screens || chosen.screens.has(screen.id)))
}

async function captureAll(stack: Stack, origins: Origins, chosen: Selection): Promise<ShotResult[]> {
  const browser = await chromium.launch()
  try {
    const diffPage = await (await browser.newContext()).newPage()
    const results: ShotResult[] = []
    let seed: SeedData | undefined
    for (const phase of ["fresh", "seeded"] as const) {
      const screens = chosenScreens(phase, chosen)
      if (screens.length === 0) continue
      if (phase === "fresh") await prepareFreshStack(stack)
      if (phase === "seeded") seed = await seedStack(stack)
      for (const screen of screens) {
        for (const size of chosen.sizes.filter((size) => !screen.sizes || screen.sizes.includes(size.name))) {
          results.push(await captureScreen(browser, diffPage, origins, screen, size, seed))
        }
      }
    }
    return results
  } finally {
    await browser.close()
  }
}

async function main() {
  const startedAt = new Date()
  const chosen = selection(process.argv.slice(2))
  await fs.rm(OUT_DIR, { recursive: true, force: true })
  await fs.mkdir(OUT_DIR, { recursive: true })
  await prepareHarness()
  const stack = await startStack({ label: "parity" })
  const closers: (() => Promise<void>)[] = []
  try {
    const origins = await startOrigins(stack.url, closers)
    const results = await captureAll(stack, origins, chosen)
    console.log(`[parity] ${results.length} comparisons: ${await writeReport(OUT_DIR, results, startedAt)}`)
  } finally {
    for (const close of closers.reverse()) await close()
    await stack.close()
  }
}

await main()
