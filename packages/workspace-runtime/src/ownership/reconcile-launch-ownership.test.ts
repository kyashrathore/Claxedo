import { afterEach, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { Database } from "bun:sqlite"
import { readCreationIdentity } from "@claxedo/agent-sdk-runtime/launch"
import { migrateLaunchOwnership, sqliteLaunchOwnership, type SqliteDatabase } from "./launch-ownership-sqlite"
import { reconcileLaunchOwnership } from "./reconcile-launch-ownership"

const posix = process.platform !== "win32"
const budgets = { termGraceMs: 1_000, killVerifyMs: 1_000 }

const children: ChildProcess[] = []
afterEach(() => {
  for (const child of children.splice(0)) {
    try { process.kill(-child.pid!, "SIGKILL") } catch {}
  }
})

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

function store() {
  const db = new Database(":memory:") as unknown as SqliteDatabase
  migrateLaunchOwnership(db)
  return sqliteLaunchOwnership(db)
}

/** A survivor of a previous owner: its own group leader, still running. */
async function survivor() {
  const child = spawn("/bin/sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" })
  children.push(child)
  await new Promise((resolve) => setTimeout(resolve, 150))
  const identity = await readCreationIdentity(child.pid!)
  return { child, identity: identity! }
}

test.skipIf(!posix)("a launch that crashed after activation is found and retired", async () => {
  const ownership = store()
  const { child, identity } = await survivor()
  const prepared = await ownership.prepare({ role: "harness", protocol: "gate", scope: { workspaceId: "ws" } })
  await ownership.recordIdentity(prepared.launchId, identity, "nonce-1")
  await ownership.authorizeActivation(prepared.launchId)

  const outcome = await reconcileLaunchOwnership(ownership, { scope: { workspaceId: "ws" }, budgets })

  expect(outcome.examined).toBe(1)
  expect(outcome.retired).toBe(1)
  expect(outcome.unresolved).toEqual([])
  expect(outcome.results[0]).toMatchObject({ execution: "unknown", outcome: "retired" })
  expect(alive(child.pid!)).toBe(false)
  expect(await ownership.listUnresolved({ workspaceId: "ws" })).toEqual([])
}, 20_000)

test.skipIf(!posix)("a prepared launch whose gate never reported closes without a signal", async () => {
  const ownership = store()
  const prepared = await ownership.prepare({ role: "harness", protocol: "gate", scope: { workspaceId: "ws" } })

  const outcome = await reconcileLaunchOwnership(ownership, { scope: { workspaceId: "ws" }, budgets })

  expect(outcome.results[0]).toMatchObject({
    launchId: prepared.launchId,
    execution: "none",
    outcome: "never_executed",
    retirement: { leader: "exited", descendants: "verified_clear", signals: [] },
  })
  expect(await ownership.listUnresolved({ workspaceId: "ws" })).toEqual([])
}, 20_000)

test.skipIf(!posix)("a direct launch prepared before a crash stays open, because its spawn is unwitnessed", async () => {
  const ownership = store()
  const prepared = await ownership.prepare({ role: "terminal", protocol: "direct", scope: { workspaceId: "ws" } })

  const outcome = await reconcileLaunchOwnership(ownership, { scope: { workspaceId: "ws" }, budgets })

  expect(outcome.results[0]).toMatchObject({
    launchId: prepared.launchId,
    execution: "unknown",
    outcome: "identity_unavailable",
  })
  expect(outcome.unresolved.length).toBe(1)
  expect((await ownership.listUnresolved({ workspaceId: "ws" })).length).toBe(1)
}, 20_000)

test.skipIf(!posix)("a recorded pid that now answers for something else is never signalled", async () => {
  const ownership = store()
  const { child, identity } = await survivor()
  const prepared = await ownership.prepare({ role: "harness", protocol: "gate", scope: { workspaceId: "ws" } })
  await ownership.recordIdentity(prepared.launchId, { ...identity, startSecond: "Thu Jan  1 00:00:00 1970" }, "nonce-1")
  await ownership.authorizeActivation(prepared.launchId)
  await ownership.acknowledgeActivation(prepared.launchId)

  const outcome = await reconcileLaunchOwnership(ownership, { scope: { workspaceId: "ws" }, budgets })

  expect(outcome.results[0]).toMatchObject({ outcome: "already_gone", execution: "started" })
  expect(alive(child.pid!)).toBe(true)
}, 20_000)

test.skipIf(!posix)("reconciliation is scoped to the workspace that asked", async () => {
  const ownership = store()
  await ownership.prepare({ role: "harness", protocol: "gate", scope: { workspaceId: "mine" } })
  await ownership.prepare({ role: "harness", protocol: "gate", scope: { workspaceId: "theirs" } })

  expect((await reconcileLaunchOwnership(ownership, { scope: { workspaceId: "mine" }, budgets })).examined).toBe(1)
  expect((await ownership.listUnresolved({ workspaceId: "theirs" })).length).toBe(1)
}, 20_000)
