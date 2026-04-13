import fs from "node:fs"
import path from "node:path"
import { Daytona, SandboxState } from "@daytonaio/sdk"
import { ensureSnapshot, WORKSPACE_DIR } from "./sandbox/image"
import { deployAndStart, stopRemoteRuntime } from "./sandbox/runtime"
import type { SandboxHandle } from "./sandbox/handle"
import type { SandboxProviderID } from "./types"
import { DaytonaSandboxHandle } from "./sandbox/daytona"
import { createModalSandbox } from "./sandbox/modal"
import { createVercelSandbox } from "./sandbox/vercel"

const repo = process.env.BENCH_REPO_URL || "https://github.com/kyashrathore/formlink.git"
const run = process.env.BENCH_RUN_ID || Date.now().toString(36)
const want = (process.env.BENCH_PROVIDERS || "daytona,modal,vercel")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean) as SandboxProviderID[]

type Phase = {
  name: string
  ms: number
}

type Result = {
  provider: SandboxProviderID
  ok: boolean
  phases: Phase[]
  err?: string
}

function envfile(file: string) {
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const text = line.trim()
    if (!text || text.startsWith("#")) continue
    const idx = text.indexOf("=")
    if (idx === -1) continue
    const key = text.slice(0, idx)
    let val = text.slice(idx + 1)
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (!process.env[key]) process.env[key] = val
  }
}

function load() {
  envfile(path.resolve(import.meta.dirname, "../../.env"))
  envfile(path.resolve(import.meta.dirname, "../../../../.env.local"))
  const file = path.resolve(import.meta.dirname, "../../../../.vercel/project.json")
  if (!fs.existsSync(file)) return
  const item = JSON.parse(fs.readFileSync(file, "utf8")) as {
    projectId?: string
    orgId?: string
  }
  process.env.VERCEL_PROJECT_ID ||= item.projectId
  process.env.VERCEL_TEAM_ID ||= item.orgId
  process.env.VERCEL_TOKEN ||= process.env.VERCEL_OIDC_TOKEN
}

load()

function now() {
  return performance.now()
}

async function time<T>(phases: Phase[], name: string, next: () => Promise<T>): Promise<T> {
  const start = now()
  try {
    return await next()
  } finally {
    phases.push({ name, ms: now() - start })
  }
}

async function daytona(phases: Phase[]) {
  const key = process.env.DAYTONA_API_KEY
  if (!key) throw new Error("DAYTONA_API_KEY missing")
  const daytona = new Daytona({ apiKey: key })
  const snapshot = await time(phases, "snapshot_ready", () => ensureSnapshot(daytona))
  const inner = await time(phases, "acquire_sandbox", () =>
    daytona.create({
      snapshot,
      labels: { app: "claxedo", pool: "benchmark", run },
      autoStopInterval: 15,
    }),
  )
  if (inner.state !== SandboxState.STARTED) {
    await time(phases, "wait_started", () => inner.waitUntilStarted(120))
  }
  return {
    handle: new DaytonaSandboxHandle(inner),
    cleanup: () => daytona.delete(inner),
  }
}

async function modal(phases: Phase[]) {
  const tokenId = process.env.MODAL_TOKEN_ID
  const tokenSecret = process.env.MODAL_TOKEN_SECRET
  if (!tokenId || !tokenSecret) throw new Error("MODAL credentials missing")
  const handle = await time(phases, "acquire_sandbox", () =>
    createModalSandbox({
      tokenId,
      tokenSecret,
      name: `bench-${run}`,
    }),
  )
  return {
    handle,
    cleanup: () => handle.destroy(),
  }
}

async function vercel(phases: Phase[]) {
  if (!process.env.VERCEL_TOKEN || !process.env.VERCEL_TEAM_ID || !process.env.VERCEL_PROJECT_ID) {
    throw new Error("Vercel credentials missing")
  }
  const handle = await time(phases, "acquire_sandbox", () => createVercelSandbox())
  return {
    handle,
    cleanup: () => handle.destroy(),
  }
}

async function acquire(provider: SandboxProviderID, phases: Phase[]) {
  if (provider === "daytona") return daytona(phases)
  if (provider === "modal") return modal(phases)
  if (provider === "vercel") return vercel(phases)
  throw new Error(`Unsupported provider: ${provider}`)
}

function close(phases: Phase[], marks: Array<{ name: string; at: number }>) {
  if (!marks.length) return
  const last = marks[marks.length - 1]
  phases.push({ name: last.name, ms: now() - last.at })
}

function report(result: Result) {
  console.log(`\n== ${result.provider} ==`)
  if (!result.ok) {
    console.log(`failed: ${result.err}`)
    return
  }
  for (const item of result.phases) {
    console.log(`${item.name.padEnd(20)} ${item.ms.toFixed(0)}ms`)
  }
  const top = result.phases.reduce((best, item) => item.ms > best.ms ? item : best, result.phases[0]!)
  const ready = result.phases
    .filter((item) => item.name !== "stop_runtime" && item.name !== "destroy_sandbox")
    .reduce((sum, item) => sum + item.ms, 0)
  console.log(`top phase             ${top.name} (${top.ms.toFixed(0)}ms)`)
  console.log(`ready total           ${ready.toFixed(0)}ms`)
}

async function bench(provider: SandboxProviderID): Promise<Result> {
  const phases: Phase[] = []
  const workspaceId = `ws_bench_${provider}_${run}`
  const marks: Array<{ name: string; at: number }> = []
  let sandbox: SandboxHandle | undefined
  let cleanup: (() => Promise<void>) | undefined
  try {
    const acquired = await acquire(provider, phases)
    sandbox = acquired.handle
    cleanup = acquired.cleanup
    await deployAndStart(sandbox, workspaceId, {
      directory: WORKSPACE_DIR,
      repoUrl: repo,
      onStep(step) {
        const at = now()
        const prev = marks[marks.length - 1]
        if (prev) phases.push({ name: prev.name, ms: at - prev.at })
        marks.push({ name: step, at })
      },
    })
    close(phases, marks)
    const handle = sandbox
    const drop = cleanup
    await time(phases, "stop_runtime", () => stopRemoteRuntime(handle, workspaceId))
    await time(phases, "destroy_sandbox", () => drop())
    return { provider, ok: true, phases }
  } catch (err) {
    if (marks.length) close(phases, marks)
    if (sandbox) {
      const handle = sandbox
      try {
        await time(phases, "stop_runtime", () => stopRemoteRuntime(handle, workspaceId))
      } catch {}
    }
    if (cleanup) {
      const drop = cleanup
      try {
        await time(phases, "destroy_sandbox", () => drop())
      } catch {}
    }
    return {
      provider,
      ok: false,
      phases,
      err: err instanceof Error ? err.message : String(err),
    }
  }
}

const results: Result[] = []

for (const provider of want) {
  results.push(await bench(provider))
}

console.log("\n== Summary ==")
for (const result of results) report(result)

const ok = results.filter((item) => item.ok)
if (ok.length) {
  const rows = ok.map((item) => {
    const ready = item.phases
      .filter((phase) => phase.name !== "stop_runtime" && phase.name !== "destroy_sandbox")
      .reduce((sum, phase) => sum + phase.ms, 0)
    const top = item.phases.reduce((best, phase) => phase.ms > best.ms ? phase : best, item.phases[0]!)
    return { provider: item.provider, ready, top }
  })
  const fastest = rows.reduce((best, item) => item.ready < best.ready ? item : best, rows[0]!)
  const slowest = rows.reduce((best, item) => item.ready > best.ready ? item : best, rows[0]!)
  console.log("\n== Ranking ==")
  for (const item of [...rows].sort((a, b) => a.ready - b.ready)) {
    console.log(`${item.provider.padEnd(10)} ${item.ready.toFixed(0)}ms  top=${item.top.name}:${item.top.ms.toFixed(0)}ms`)
  }
  console.log(`\nfastest: ${fastest.provider} (${fastest.ready.toFixed(0)}ms)`)
  console.log(`slowest: ${slowest.provider} (${slowest.ready.toFixed(0)}ms)`)
}
