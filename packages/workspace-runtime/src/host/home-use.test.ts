import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  retire,
  retirementSettled,
  verifyCreationIdentity,
  volatileLaunchOwnership,
  type CreationIdentity,
  type IdentityVerdict,
} from "@claxedo/process-ownership/launch"
import { sqliteLaunchOwnership } from "../ownership/launch-ownership-sqlite"
import { openSqliteDatabase } from "../sqlite/node"
import { HARNESS_HOME_MAX_IDLE_MS, homeHoldingOwnership, recordHarnessHomeUse, sweepHarnessHomeRoot } from "./home-use"
import { sweepIdleHarnessHomes } from "./composition"

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })

const identity: CreationIdentity = { pid: 5_000_001, processGroupId: 5_000_001, parentPid: 5_000_002,
  startSecond: "1", bootTime: "boot", startedAtMs: 1000, source: "darwin-ps" }
const settled = { leader: "exited" as const, descendants: "verified_clear" as const, signals: [] }

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "home-use-"))
  roots.push(root)
  const homes = path.join(root, "cursor", "homes")
  const home = path.join(homes, "session")
  await fs.mkdir(path.join(home, ".cursor"), { recursive: true })
  let now = Date.now()
  let verdict: IdentityVerdict["state"] = "live"
  const deps = {
    now: () => now,
    remove: (directory: string) => fs.rm(directory, { recursive: true, force: true }),
    verify: async (): Promise<IdentityVerdict> => verdict === "live" ? { state: "live", identity }
      : verdict === "exited" ? { state: "exited" } : { state: "unknown", reason: "unavailable" },
  }
  const ownership = volatileLaunchOwnership()
  const launch = async () => {
    const holding = homeHoldingOwnership(ownership, home, deps)
    const prepared = await holding.prepare({ role: "harness", protocol: "gate" })
    await holding.recordIdentity(prepared.launchId, identity)
    return { retire: () => holding.recordRetirement(prepared.launchId, settled) }
  }
  return { root, homes, home, deps, launch, sweep: () => sweepHarnessHomeRoot(homes, now, deps),
    age() { now += HARNESS_HOME_MAX_IDLE_MS + 1 }, verdict(value: typeof verdict) { verdict = value } }
}

test("root mtime cannot delete an untracked home with an active descendant", async () => {
  const f = await fixture()
  const old = new Date(Date.now() - HARNESS_HOME_MAX_IDLE_MS - 1000)
  await fs.utimes(f.home, old, old)
  await fs.writeFile(path.join(f.home, ".cursor", "active"), "current session")
  expect(await sweepIdleHarnessHomes(f.root)).toEqual([])
})

test("a home stays until its last launch retires, and retirement records its last use", async () => {
  const f = await fixture()
  const first = await f.launch()
  const second = await f.launch()
  f.age()
  await first.retire()
  f.age()
  expect(await f.sweep()).toEqual([])
  await second.retire()
  expect(await f.sweep()).toEqual([])
  f.age()
  expect(await f.sweep()).toEqual([f.home])
  expect(await fs.exists(f.home)).toBe(false)
})

test("an unknown launch identity retains the home; a launch proven gone releases it from that sweep on", async () => {
  const f = await fixture()
  await f.launch()
  f.age()
  f.verdict("unknown")
  expect(await f.sweep()).toEqual([])
  f.verdict("exited")
  expect(await f.sweep()).toEqual([])
  f.age()
  expect(await f.sweep()).toEqual([f.home])
})

test("a use recorded during the sweep's identity check survives that sweep", async () => {
  const f = await fixture()
  await f.launch()
  f.age()
  const deps = { ...f.deps, verify: async (): Promise<IdentityVerdict> => {
    f.age()
    recordHarnessHomeUse(f.home, f.deps)
    return { state: "exited" }
  } }
  expect(await sweepHarnessHomeRoot(f.homes, f.deps.now(), deps)).toEqual([])
  expect(await fs.exists(f.home)).toBe(true)
})

test("a collected home is set aside under the ledger lock and removed after it is released", async () => {
  const f = await fixture()
  recordHarnessHomeUse(f.home, f.deps)
  f.age()
  const removals: { directory: string; homePresent: boolean; ledgerWritable: boolean }[] = []
  const remove = async (directory: string) => {
    const ledger = new Database(path.join(f.homes, ".usage.sqlite"))
    ledger.exec("PRAGMA busy_timeout = 0")
    let ledgerWritable = true
    try { ledger.exec("BEGIN IMMEDIATE"); ledger.exec("ROLLBACK") } catch { ledgerWritable = false } finally { ledger.close() }
    removals.push({ directory, homePresent: await fs.exists(f.home), ledgerWritable })
    await fs.rm(directory, { recursive: true, force: true })
  }
  expect(await sweepHarnessHomeRoot(f.homes, f.deps.now(), { ...f.deps, remove })).toEqual([f.home])
  expect(removals).toHaveLength(1)
  expect(removals[0]).toMatchObject({ homePresent: false, ledgerWritable: true })
  expect(path.dirname(removals[0]?.directory ?? "")).toBe(path.join(f.homes, ".collected"))
})

test("a removal that fails is retried by the next sweep", async () => {
  const f = await fixture()
  recordHarnessHomeUse(f.home, f.deps)
  f.age()
  const refused = { ...f.deps, remove: async () => { throw new Error("scripted removal refusal") } }
  await expect(sweepHarnessHomeRoot(f.homes, f.deps.now(), refused)).rejects.toThrow("could not be removed")
  expect(await fs.exists(f.home)).toBe(false)
  expect(await fs.readdir(path.join(f.homes, ".collected"))).toHaveLength(1)
  expect(await f.sweep()).toEqual([])
  expect(await fs.readdir(path.join(f.homes, ".collected"))).toEqual([])
})

// libuv puts a non-detached Windows child in a kill-on-close job, so no harness outlives the runtime that launched it there.
test.skipIf(process.platform === "win32")("a harness that outlives its runtime keeps its home until its launch is proven retired", async () => {
  const f = await fixture()
  const ledger = path.join(f.root, "launches.sqlite")
  const runtime = Bun.spawn([process.execPath, path.join(import.meta.dirname, "../test-support/home-runtime.ts"), f.home, ledger],
    { stdout: "pipe", stderr: "pipe" })
  const [code, stderr] = await Promise.all([runtime.exited, new Response(runtime.stderr).text()])
  expect(code, stderr).toBe(0)
  const db = openSqliteDatabase(ledger)
  const [launch] = await sqliteLaunchOwnership(db, { ownerGeneration: "test", scope: { kind: "standalone" } }).listUnresolved({ kind: "standalone" })
  db.close()
  const survivor = launch?.identity
  if (!survivor) throw new Error("The runtime recorded no harness launch identity")
  try {
    expect((await verifyCreationIdentity(survivor)).state).toBe("live")
    expect(await sweepHarnessHomeRoot(f.homes, Date.now() + HARNESS_HOME_MAX_IDLE_MS + 1)).toEqual([])
    expect(await fs.exists(f.home)).toBe(true)
  } finally {
    expect(retirementSettled(await retire({ identity: survivor }, { termGraceMs: 500, killVerifyMs: 2_000 }))).toBe(true)
  }
  const later = Date.now() + HARNESS_HOME_MAX_IDLE_MS + 1
  expect(await sweepHarnessHomeRoot(f.homes, later)).toEqual([])
  expect(await sweepHarnessHomeRoot(f.homes, later + HARNESS_HOME_MAX_IDLE_MS + 1)).toEqual([f.home])
}, 20_000)
