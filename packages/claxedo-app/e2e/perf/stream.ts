import { chromium } from "@playwright/test"
import fs from "node:fs/promises"
import path from "node:path"
import { ClaxedoApi } from "../harness/api"
import { ensureAppBuilt } from "../harness/app"
import { git } from "../../../harness/e2e/harness/git"
import { prepareHarness } from "../harness/global-setup"
import { startStack, type Stack } from "../harness/stack"
import { startAppOrigin, type AppOrigin } from "./origin"
import { measure } from "./measure"
import { readOptions, runOrder, type Variant } from "./options"
import { seedScriptedSession } from "./seed"

const SEED_TURNS = 22
const LAST_SEED_TEXT = `Seed turn ${SEED_TURNS} done.`

async function startOrigin(variant: Variant, daemonUrl: string, closers: (() => Promise<void>)[]): Promise<AppOrigin> {
  const serverUrl = `http://127.0.0.1:${variant.port}`
  const outDir = path.join(import.meta.dirname, "dist", variant.name)
  const distDir = variant.dist ?? (await ensureAppBuilt({ serverUrl, outDir })).distDir
  const origin = await startAppOrigin({ port: variant.port, distDir, daemonUrl })
  closers.push(() => origin.close())
  return origin
}

async function makeWorkspace(stack: Stack) {
  const workspace = await stack.daemon.makeWorkspace("stream", "Stream")
  await fs.mkdir(path.join(workspace.directory, "src"), { recursive: true })
  await fs.writeFile(path.join(workspace.directory, "src/values.ts"), "export const value0 = 0\n")
  await git(workspace.directory, "add", "--", "src/values.ts")
  await git(workspace.directory, "commit", "-q", "-m", "values", "--", "src/values.ts")
  return workspace
}

async function main() {
  const options = readOptions(process.argv.slice(2))
  await fs.mkdir(options.out, { recursive: true })
  await prepareHarness()
  const stack = await startStack({ label: "perf-stream" })
  const closers: (() => Promise<void>)[] = []
  try {
    const api = new ClaxedoApi(stack.url)
    const workspace = await makeWorkspace(stack)
    const origins = new Map<string, AppOrigin>()
    for (const variant of options.variants) origins.set(variant.name, await startOrigin(variant, stack.url, closers))
    const order = runOrder(options)
    const sessions: string[] = []
    for (let index = 0; index < order.length; index += 1) sessions.push(await seedScriptedSession({ api, directory: workspace.directory, writeScript: (name, script) => stack.acp.write(name, script), title: `perf-${index}`, turns: SEED_TURNS }))
    console.log(`[perf] seeded ${sessions.length} sessions × ${SEED_TURNS} turns`)
    const browser = await chromium.launch({ channel: "chromium" })
    try {
      const results = []
      for (const [index, variant] of order.entries()) {
        const origin = origins.get(variant.name)
        const sessionId = sessions[index]
        if (!origin || !sessionId) throw new Error(`run ${index} has no origin or session`)
        const result = await measure({ browser, variant, origin, api, stack, workspace, sessionId, run: index, options, lastSeedText: LAST_SEED_TEXT })
        console.log(JSON.stringify(result, (key, value: unknown) => key === "topSelf" || key === "loafTop" ? undefined : value))
        results.push(result)
      }
      await fs.writeFile(path.join(options.out, `${options.label}-summary.json`), JSON.stringify(results, null, 1))
    } finally {
      await browser.close()
    }
  } finally {
    for (const close of closers.reverse()) await close()
    await stack.close()
  }
}

await main()
