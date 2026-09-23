// Live Daytona verification round 2 for P-86/P-137 — destroy-path isolation and
// GC keep-path, WITHOUT snapshot/checkpoint (this key can create but not delete
// org snapshots; two leaked rows from round 1 are already documented).
// NOT for commit.
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { createSandboxManager, type SandboxLease } from "./src/index"
import { createDaytonaSandboxDriver } from "./src/drivers/daytona"
import { createMemoryLeaseStore } from "./src/stores/memory"

const envFile = resolve(import.meta.dir, "../claxedo-server/.env")
const apiKey = readFileSync(envFile, "utf8").match(/^DAYTONA_API_KEY=(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "")
if (!apiKey) throw new Error("DAYTONA_API_KEY missing")

const { Daytona } = await import("@daytona/sdk")
const sdk = new Daytona({ apiKey, _experimental: { otelEnabled: false } })

const WS_A = `verify2-p86-a-${Date.now().toString(36)}`
const WS_B = `verify2-p86-b-${Date.now().toString(36)}`

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS ${name}${detail !== undefined ? " — " + JSON.stringify(detail) : ""}`) }
  else { fail++; console.log(`FAIL ${name}${detail !== undefined ? " — " + JSON.stringify(detail) : ""}`) }
}

// Same client wrapper as round 1: real SDK for everything; secret channel is an
// empty shim because this key denies all secret.* calls ("Access denied").
const client = {
  async findByLabels(labels: Record<string, string>) {
    for await (const sandbox of sdk.list({ labels })) return sandbox
    return undefined
  },
  async list(labels?: Record<string, string>, page = 1, limit?: number) {
    if (page > 1) return { items: [] }
    const items = []
    for await (const sandbox of sdk.list({ ...(labels ? { labels } : {}), ...(limit ? { limit } : {}) })) items.push(sandbox)
    return { items }
  },
  create(params: Record<string, unknown>, opts?: { timeout?: number }) {
    const { secrets, ...rest } = params
    if (secrets) console.log("[verify] create: stripped brokered-secret mounts:", Object.keys(secrets as object))
    return sdk.create(rest as never, opts)
  },
  get: (sandboxIdOrName: string) => sdk.get(sandboxIdOrName),
  secret: {
    async list() { return { items: [], nextCursor: null } },
    async create(params: { name: string }) {
      console.log("[verify] secret.create shimmed:", params.name)
      return { id: "secret-scope-denied", name: params.name }
    },
    async update() { return {} },
    async delete() {},
  },
}
const leaseStore = createMemoryLeaseStore()
const driver = createDaytonaSandboxDriver({
  apiKey, baseSnapshot: "daytona-small", operationTimeoutSeconds: 240,
  client: client as never, warn: (m) => console.log("[driver-warn]", m),
})
const manager = createSandboxManager({ leaseStore, driver })

async function ensureReady(workspaceId: string) {
  for (let i = 0; i < 60; i++) {
    const r = await manager.ensure(workspaceId, { homeRegion: "us-east", bootSource: { kind: "default" } })
    if (r.status === "ready") return r
    if (r.status === "unavailable") throw new Error(`ensure ${workspaceId} unavailable: ${r.error}`)
    await new Promise((res) => setTimeout(res, r.retryAfterMs + 250))
  }
  throw new Error(`ensure ${workspaceId} timed out`)
}

async function providerState(id: string) {
  return sdk.get(id).then((s) => (s as any).state ?? "listed").catch((e) => `error:${e instanceof Error ? e.message : String(e)}`)
}

const created = new Set<string>()
try {
  console.log(`== provisioning A (${WS_A}) and B (${WS_B}) ==`)
  const tA = await ensureReady(WS_A); created.add(tA.sandboxId)
  const tB = await ensureReady(WS_B); created.add(tB.sandboxId)
  const leaseA = (await leaseStore.get(WS_A))!
  const leaseB = (await leaseStore.get(WS_B))!
  console.log("leaseA:", JSON.stringify({ sandboxId: leaseA.sandboxId, hostId: leaseA.hostId, epoch: leaseA.epoch }))
  console.log("leaseB:", JSON.stringify({ sandboxId: leaseB.sandboxId, hostId: leaseB.hostId, epoch: leaseB.epoch }))

  // Identity-rewrite attempts (same as round 1, condensed).
  await manager.heartbeat(WS_A, {
    epoch: leaseA.epoch, ok: true,
    // @ts-expect-error out-of-contract smuggled identity
    sandboxId: leaseB.sandboxId, hostId: leaseB.hostId, url: leaseB.url, driverResourceId: leaseB.driverResourceId,
  })
  await leaseStore.update(WS_A, leaseA.epoch, {
    // @ts-expect-error identity keys are not part of SandboxLeasePatch
    sandboxId: leaseB.sandboxId, hostId: leaseB.hostId, url: leaseB.url, driverResourceId: leaseB.driverResourceId,
  })
  const after = (await leaseStore.get(WS_A))!
  check("P-86: heartbeat+patch cannot repoint lease A at B",
    after.sandboxId === leaseA.sandboxId && after.hostId === leaseA.hostId && after.url === leaseA.url)

  // GC with both leases at their provisioning epoch: both provider-labeled
  // sandboxes match their lease identity, so both are kept.
  const gc = await manager.garbageCollect()
  check("P-86: GC keeps both live sandboxes (provider labels match lease identity)",
    gc.kept.length === 2 && gc.destroyed.length === 0 && gc.failed.length === 0,
    { kept: gc.kept.map((t) => t.sandboxId), destroyed: gc.destroyed.length, failed: gc.failed })

  // The decisive isolation check: destroying A through the manager must delete
  // exactly A's provider resource and leave B running.
  const de = await manager.destroy(WS_A)
  check("P-86: manager.destroy(A) ok", de.ok === true, de)
  await new Promise((r) => setTimeout(r, 3000))
  const aState = await providerState(leaseA.sandboxId!)
  const bState = await providerState(leaseB.sandboxId!)
  check("P-86: provider shows sandbox A deleted/destroying after destroy(A)",
    aState.startsWith("error") || aState === "destroyed" || aState === "destroying" || aState === "archived",
    { aState })
  check("P-86: provider shows sandbox B untouched by destroy(A)",
    bState === "started", { bState })
} finally {
  console.log("\n== cleanup ==")
  for (const ws of [WS_A, WS_B]) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await manager.destroy(ws).catch((e) => ({ ok: false, reason: e instanceof Error ? e.message : String(e) }))
      console.log(`destroy(${ws}) attempt ${attempt}:`, JSON.stringify(r))
      if ((r as any).ok) break
      await new Promise((res) => setTimeout(res, 5000))
    }
    await manager.release(ws).catch(() => undefined)
  }
  await new Promise((r) => setTimeout(r, 5000))
  const remaining: string[] = []
  for await (const s of sdk.list()) {
    if (created.has(s.id) || s.name?.includes("verify2-p86")) {
      remaining.push(`${s.id}:${s.name}:${s.state}`)
      await s.delete(120).catch(() => undefined)
    }
  }
  await new Promise((r) => setTimeout(r, 5000))
  const still: string[] = []
  for await (const s of sdk.list()) {
    if (created.has(s.id) || s.name?.includes("verify2-p86")) still.push(`${s.id}:${s.name}:${s.state}`)
  }
  check("cleanup: no verification sandboxes remain at provider", still.length === 0,
    { firstSweep: remaining, remaining: still })
}

console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====`)
process.exit(fail ? 1 : 0)
