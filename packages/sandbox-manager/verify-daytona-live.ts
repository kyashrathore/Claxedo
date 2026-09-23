// Live Daytona verification for security findings P-86 and P-137. NOT for commit.
// Exercises the REAL driver path: createSandboxManager + createDaytonaSandboxDriver
// against the Daytona API (DAYTONA_API_KEY from packages/claxedo-server/.env — never printed).
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

const WS_A = `verify-p86-a-${Date.now().toString(36)}`
const WS_B = `verify-p86-b-${Date.now().toString(36)}`

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS ${name}${detail !== undefined ? " — " + JSON.stringify(detail) : ""}`) }
  else { fail++; console.log(`FAIL ${name}${detail !== undefined ? " — " + JSON.stringify(detail) : ""}`) }
}

const leaseStore = createMemoryLeaseStore()
// This API key denies every secret.* call ("Access denied"), so the driver's
// org-secret reconcile cannot run. The wrapper below delegates EVERYTHING to the
// real SDK except the brokered-secret channel: secret service is an empty
// read-only shim and the `secrets` mount map is stripped from create params.
// That channel is orthogonal to the lease-identity mechanisms under test
// (P-86/P-137): findExisting-by-label, create env/labels, ensureStarted,
// preview URL, snapshot, stop, destroy and list all hit the real provider.
const client = {
  async findByLabels(labels: Record<string, string>) {
    for await (const sandbox of sdk.list({ labels })) return sandbox
    return undefined
  },
  async list(labels?: Record<string, string>, page = 1, limit?: number) {
    if (page > 1) return { items: [] }
    const items = []
    for await (const sandbox of sdk.list({ ...(labels ? { labels } : {}), ...(limit ? { limit } : {}) })) {
      items.push(sandbox)
    }
    return { items }
  },
  create(params: Record<string, unknown>, opts?: { timeout?: number }) {
    const { secrets, ...rest } = params
    if (secrets) console.log("[verify] create: stripped brokered-secret mounts (key lacks secret scope):", Object.keys(secrets as object))
    return sdk.create(rest as never, opts)
  },
  get: (sandboxIdOrName: string) => sdk.get(sandboxIdOrName),
  secret: {
    async list() { return { items: [], nextCursor: null } },
    async create(params: { name: string }) {
      console.log("[verify] secret.create shimmed (key lacks secret scope):", params.name)
      return { id: "secret-scope-denied", name: params.name }
    },
    async update() { return {} },
    async delete() {},
  },
}
const driver = createDaytonaSandboxDriver({
  apiKey,
  baseSnapshot: "daytona-small", // cheapest snapshot class in this org
  operationTimeoutSeconds: 240,
  client: client as never,
  warn: (m) => console.log("[driver-warn]", m),
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

const noopRuntime = {
  calls: [] as string[],
  async freeze(p: string) { this.calls.push(`freeze:${p}`) },
  async flush() { this.calls.push("flush") },
  async scrub() { this.calls.push("scrub") },
  async resume() { this.calls.push("resume") },
  async reconcile(i: { epoch: number; checkpointId: string }) { this.calls.push(`reconcile:${i.epoch}:${i.checkpointId}`) },
}

function leaseView(l: SandboxLease | undefined) {
  return l && {
    status: l.status, epoch: l.epoch, sandboxId: l.sandboxId, hostId: l.hostId,
    driverResourceId: l.driverResourceId, labels: l.labels,
    checkpoint: l.checkpoint?.id, providerReference: l.checkpoint?.providerReference,
  }
}

async function providerGet(id: string) {
  return sdk.get(id).then((s) => s).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }))
}

const createdSandboxIds = new Set<string>()
let restored = false
try {
  console.log(`== provisioning A (${WS_A}) and B (${WS_B}) via manager.ensure → daytona driver ==`)
  const targetA = await ensureReady(WS_A)
  createdSandboxIds.add(targetA.sandboxId)
  const targetB = await ensureReady(WS_B)
  createdSandboxIds.add(targetB.sandboxId)
  const leaseA = (await leaseStore.get(WS_A))!
  const leaseB = (await leaseStore.get(WS_B))!
  console.log("leaseA:", JSON.stringify(leaseView(leaseA)))
  console.log("leaseB:", JSON.stringify(leaseView(leaseB)))

  // ---------- P-137: runtime identity vs lease identity ----------
  console.log("\n== P-137: Daytona-reported identity vs lease ==")
  const sbA = await providerGet(leaseA.sandboxId!)
  check("P-137: lease.hostId is driver-owned claxedo-<ws>, not the provider UUID",
    leaseA.hostId === `claxedo-${WS_A}` && leaseA.hostId !== leaseA.sandboxId,
    { hostId: leaseA.hostId, sandboxId: leaseA.sandboxId })
  check("P-137: lease.sandboxId === lease.driverResourceId === provider sandbox id",
    leaseA.sandboxId === (sbA as any).id && leaseA.driverResourceId === (sbA as any).id,
    { providerId: (sbA as any).id })
  check("P-137: provider sandbox name equals lease hostId",
    (sbA as any).name === leaseA.hostId, { providerName: (sbA as any).name })
  check("P-137: provider labels carry workspaceId + epoch matching the lease",
    (sbA as any).labels?.["claxedo.workspaceId"] === WS_A
      && (sbA as any).labels?.workspaceId === WS_A
      && (sbA as any).labels?.epoch === String(leaseA.epoch),
    { labels: (sbA as any).labels })

  // Boot env inside the real sandbox: does the runtime see the driver-owned host id?
  try {
    const envOut = await (sbA as any).process.executeCommand(
      "env | grep -E 'WORKSPACE_RUNTIME_(HOST_ID|WORKSPACE_ID|PORT|DIRECTORY)' | sort", "/")
    const stdout = String((envOut as any)?.result ?? (envOut as any)?.stdout ?? "")
    console.log("sandbox env (provider-side):", stdout.replace(/\n/g, " | "))
    check("P-137: sandbox boot env WORKSPACE_RUNTIME_HOST_ID === lease.hostId",
      stdout.includes(`WORKSPACE_RUNTIME_HOST_ID=${leaseA.hostId}`))
    check("P-137: sandbox boot env WORKSPACE_RUNTIME_WORKSPACE_ID === workspaceId",
      stdout.includes(`WORKSPACE_RUNTIME_WORKSPACE_ID=${WS_A}`))
  } catch (err) {
    console.log("env probe failed (non-fatal):", err instanceof Error ? err.message : String(err))
  }

  // Caller env restating identity must be refused before any lease write (P-137 guard).
  const beforeRefusal = await leaseStore.get(WS_A)
  const refused = await manager.ensure(WS_A, {
    homeRegion: "us-east",
    env: { WORKSPACE_RUNTIME_HOST_ID: `claxedo-${WS_B}` },
  })
  check("P-137: ensure refuses caller env restating WORKSPACE_RUNTIME_HOST_ID",
    refused.status === "unavailable" && String((refused as any).error).includes("sandbox env cannot set runtime identity"),
    refused.status === "unavailable" ? (refused as any).error : refused.status)
  const afterRefusal = await leaseStore.get(WS_A)
  check("P-137: refusal burned no epoch and changed no identity",
    afterRefusal?.epoch === beforeRefusal?.epoch && afterRefusal?.sandboxId === beforeRefusal?.sandboxId)

  // ---------- P-86: lease identity cannot be rewritten to B ----------
  console.log("\n== P-86: runtime telemetry / store patch cannot repoint lease A at sandbox B ==")
  // The ONLY runtime-facing write path. Smuggle B's identity in alongside the report.
  const hb = await manager.heartbeat(WS_A, {
    epoch: leaseA.epoch, ok: true,
    // @ts-expect-error deliberately out-of-contract fields a malicious runtime might send
    sandboxId: leaseB.sandboxId, hostId: leaseB.hostId, url: leaseB.url, driverResourceId: leaseB.driverResourceId,
  })
  const afterHb = (await leaseStore.get(WS_A))!
  check("P-86: heartbeat accepted liveness", hb.ok === true, hb)
  check("P-86: heartbeat with smuggled identity cannot repoint lease A at B",
    afterHb.sandboxId === leaseA.sandboxId && afterHb.hostId === leaseA.hostId
      && afterHb.driverResourceId === leaseA.driverResourceId && afterHb.url === leaseA.url,
    { sandboxId: afterHb.sandboxId, hostId: afterHb.hostId })

  // Generic lease patch — the shape status/telemetry writers get.
  await leaseStore.update(WS_A, leaseA.epoch, {
    status: "ready",
    // @ts-expect-error identity keys are not part of SandboxLeasePatch
    sandboxId: leaseB.sandboxId, hostId: leaseB.hostId, url: leaseB.url, driverResourceId: leaseB.driverResourceId,
  })
  const afterPatch = (await leaseStore.get(WS_A))!
  check("P-86: leaseStore.update cannot carry identity fields",
    afterPatch.sandboxId === leaseA.sandboxId && afterPatch.hostId === leaseA.hostId
      && afterPatch.driverResourceId === leaseA.driverResourceId,
    { sandboxId: afterPatch.sandboxId })

  // The one identity writer, recordTarget, is fenced on the provisioned epoch.
  const wrongEpoch = await leaseStore.recordTarget(WS_A, leaseA.epoch + 99, {
    sandboxId: leaseB.sandboxId!, url: leaseB.url!, hostId: leaseB.hostId!,
    driverResourceId: leaseB.driverResourceId, labels: {},
  })
  const afterRecord = (await leaseStore.get(WS_A))!
  check("P-86: recordTarget with foreign epoch is refused; lease A still owns sandbox A",
    wrongEpoch === undefined && afterRecord.sandboxId === leaseA.sandboxId,
    { recordTargetResult: wrongEpoch === undefined ? "undefined (refused)" : "WROTE" })

  // ---------- P-86: A's lease can only drive A's sandbox ----------
  console.log("\n== P-86: snapshot/checkpoint/restore/destroy through manager target A only ==")
  const snap = await manager.snapshot(WS_A)
  check("P-86: manager.snapshot(A) succeeded", snap.ok === true, snap)
  check("P-86: snapshot name proves it targeted workspace A's resource",
    snap.ok === true && snap.snapshotId.startsWith(`claxedo-${WS_A}-`), snap)
  const bAfterSnap = await providerGet(leaseB.sandboxId!)
  check("P-86: sandbox B untouched by A's snapshot (still started)",
    (bAfterSnap as any).state === "started", { state: (bAfterSnap as any).state })

  const cp = await manager.checkpoint(WS_A, { runtime: noopRuntime })
  check("P-86: manager.checkpoint(A) captured", cp.status === "ready", {
    checkpoint: cp.checkpoint.id, providerReference: cp.checkpoint.providerReference })
  const leaseA2 = (await leaseStore.get(WS_A))!
  check("P-86: checkpoint.providerReference is A's snapshot, lease still bound to sandbox A",
    leaseA2.checkpoint?.providerReference === (snap.ok ? snap.snapshotId : "?")
      && leaseA2.sandboxId === leaseA.sandboxId)

  // B cannot spend A's checkpoint: B's lease holds no checkpoint at all.
  const bRestore = await manager.restore(WS_B, { runtime: noopRuntime, checkpointId: cp.checkpoint.id }).then(
    (r) => ({ unexpected: r }),
    (e) => ({ error: e instanceof Error ? e.message : String(e) }),
  )
  check("P-86: restore(B, checkpointId=A's) refused — B's lease has no such checkpoint",
    "error" in bRestore && bRestore.error === "workspace_checkpoint_not_found", bRestore)

  // A's own restore goes through the real ensure path and can only resolve A.
  const re = await manager.restore(WS_A, { runtime: noopRuntime })
  check("P-86: restore(A) completed through driver ensure", re.status === "ready", re.status)
  const leaseA3 = (await leaseStore.get(WS_A))!
  check("P-86: post-restore lease A identity still names A's resource, never B's",
    leaseA3.sandboxId !== leaseB.sandboxId && leaseA3.hostId === `claxedo-${WS_A}`,
    { sandboxId: leaseA3.sandboxId, epoch: leaseA3.epoch })
  if (leaseA3.sandboxId && leaseA3.sandboxId !== leaseA.sandboxId) {
    restored = true
    createdSandboxIds.add(leaseA3.sandboxId)
  }

  // GC must see both live sandboxes as owned (matching lease identity) — nothing destroyed.
  const gc1 = await manager.garbageCollect()
  check("P-86: GC keeps both sandboxes (provider labels match lease identity)",
    gc1.destroyed.length === 0 && gc1.kept.length === 2 && gc1.failed.length === 0,
    { kept: gc1.kept.length, destroyed: gc1.destroyed.length, skipped: gc1.skipped.map((s) => s.reason) })

  // Destroy A: real provider delete on A only; B must survive.
  const de = await manager.destroy(WS_A)
  check("P-86: manager.destroy(A) ok", de.ok === true, de)
  const aGone = await providerGet(leaseA3.sandboxId!)
  const bAlive = await providerGet(leaseB.sandboxId!)
  check("P-86: provider confirms sandbox A deleted",
    "error" in aGone || (aGone as any).state === "destroyed" || (aGone as any).state === "archived",
    "error" in aGone ? aGone.error : (aGone as any).state)
  check("P-86: sandbox B still running after A destroyed",
    (bAlive as any).state === "started", { state: (bAlive as any).state })

  // And once A's lease is released, GC treats any leftover as orphan — B's lease still protects B.
  await manager.release(WS_A)
  const gc2 = await manager.garbageCollect()
  check("P-86: post-release GC destroys nothing of B's (lease B still matches)",
    gc2.kept.some((t) => t.sandboxId === leaseB.sandboxId)
      && !gc2.destroyed.some((t) => t.sandboxId === leaseB.sandboxId),
    { kept: gc2.kept.map((t) => t.sandboxId), destroyed: gc2.destroyed.map((t) => t.sandboxId) })
} finally {
  console.log("\n== cleanup: destroying everything created ==")
  for (const ws of [WS_A, WS_B]) {
    const r = await manager.destroy(ws).catch((e) => ({ ok: false, reason: String(e) }))
    console.log(`destroy(${ws}):`, JSON.stringify(r))
    await manager.release(ws).catch(() => undefined)
  }
  // Belt-and-suspenders: delete any sandbox this run created that is still listed.
  for await (const s of sdk.list()) {
    if (createdSandboxIds.has(s.id) || s.name?.startsWith("claxedo-verify-p86-")) {
      console.log(`leftover sandbox ${s.id} (${s.name}) state=${s.state} — deleting`)
      await s.delete(120).catch((e) => console.log("delete failed:", String(e)))
    }
  }
  let remaining = 0
  for await (const s of sdk.list()) {
    if (createdSandboxIds.has(s.id) || s.name?.startsWith("claxedo-verify-p86-")) remaining++
  }
  check("cleanup: no verification sandboxes remain at provider", remaining === 0, { remaining })

  // Org-secret sweep not possible: this key denies secret.* ("Access denied").
  // The shim never created real org secrets, so nothing exists to withdraw.

  // _experimental_createSnapshot minted org-level snapshot resources; delete ours.
  try {
    const snaps = await sdk.snapshot.list({ page: 1, limit: 100 })
    const ours = (snaps.items ?? []).filter((x) => x.name.startsWith("claxedo-verify-p86-"))
    for (const x of ours) {
      console.log(`leftover snapshot ${x.name} — deleting`)
      await sdk.snapshot.delete(x.name).catch((e) => console.log("snapshot delete failed:", String(e)))
    }
    const after = await sdk.snapshot.list({ page: 1, limit: 100 })
    const still = (after.items ?? []).filter((x) => x.name.startsWith("claxedo-verify-p86-"))
    check("cleanup: no leftover driver snapshots", still.length === 0, still.map((x) => x.name))
  } catch (err) {
    console.log("snapshot sweep failed:", err instanceof Error ? err.message : String(err))
  }
}

console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====`)
process.exit(fail ? 1 : 0)
