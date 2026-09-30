import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, renameSync } from "node:fs"
import { readdir, rm } from "node:fs/promises"
import path from "node:path"
import {
  isCreationIdentity,
  retirementSettled,
  verifyCreationIdentity,
  type LaunchOwnershipStore,
} from "@claxedo/process-ownership/launch"
import { isRecord } from "@claxedo/helpers/guards"
import type { SqliteDatabase } from "../sqlite/database"
import { openSqliteDatabase } from "../sqlite/node"

export const HARNESS_HOME_MAX_IDLE_MS = 30 * 24 * 60 * 60 * 1000

const COLLECTED = ".collected"

export type HarnessHomeDependencies = {
  verify: typeof verifyCreationIdentity
  remove(directory: string): Promise<void>
  now(): number
}

const defaults: HarnessHomeDependencies = {
  verify: verifyCreationIdentity,
  remove: (directory) => rm(directory, { recursive: true, force: true }),
  now: Date.now,
}

function withLedger<T>(root: string, operation: (db: SqliteDatabase) => T): T {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const db = openSqliteDatabase(path.join(root, ".usage.sqlite"))
  try {
    db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS home_use (home TEXT PRIMARY KEY, last_used INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS home_launch (launch_id TEXT PRIMARY KEY, home TEXT NOT NULL, identity TEXT NOT NULL);`)
    return operation(db)
  } finally { db.close() }
}

function recordLastUse(db: SqliteDatabase, home: string, now: number): void {
  db.prepare("INSERT INTO home_use VALUES (?, ?) ON CONFLICT(home) DO UPDATE SET last_used = MAX(last_used, excluded.last_used)").run(home, now)
}

export function recordHarnessHomeUse(home: string, deps: Pick<HarnessHomeDependencies, "now"> = defaults): void {
  withLedger(path.dirname(home), (db) => db.transaction(() => recordLastUse(db, home, deps.now())))
}

export function homeHoldingOwnership(ownership: LaunchOwnershipStore, home: string,
  deps: Pick<HarnessHomeDependencies, "now"> = defaults): LaunchOwnershipStore {
  const root = path.dirname(home)
  return {
    ownerGeneration: ownership.ownerGeneration,
    prepare: (input) => ownership.prepare(input),
    authorizeActivation: (launchId) => ownership.authorizeActivation(launchId),
    acknowledgeActivation: (launchId) => ownership.acknowledgeActivation(launchId),
    read: (launchId) => ownership.read(launchId),
    listUnresolved: (scope) => ownership.listUnresolved(scope),
    async recordIdentity(launchId, identity, gateNonce) {
      await ownership.recordIdentity(launchId, identity, gateNonce)
      withLedger(root, (db) => db.transaction(() => {
        recordLastUse(db, home, deps.now())
        db.prepare("INSERT INTO home_launch VALUES (?, ?, ?)").run(launchId, home, JSON.stringify(identity))
      }))
    },
    async recordRetirement(launchId, result) {
      await ownership.recordRetirement(launchId, result)
      if (!retirementSettled(result)) return
      withLedger(root, (db) => db.transaction(() => {
        recordLastUse(db, home, deps.now())
        db.prepare("DELETE FROM home_launch WHERE launch_id = ?").run(launchId)
      }))
    },
  }
}

async function retiredLaunches(root: string, deps: HarnessHomeDependencies): Promise<string[]> {
  const launches = withLedger(root, (db) => db.prepare<{ launch_id: string; identity: string }>("SELECT launch_id, identity FROM home_launch").all())
  const retired: string[] = []
  for (const launch of launches) {
    const identity: unknown = JSON.parse(launch.identity)
    if (!isCreationIdentity(identity)) throw new Error(`Harness home launch ${launch.launch_id} has an unreadable identity`)
    const verdict = await deps.verify(identity)
    if (verdict.state === "exited" || verdict.state === "identity_mismatch") retired.push(launch.launch_id)
  }
  return retired
}

function setAside(root: string, home: string): boolean {
  mkdirSync(path.join(root, COLLECTED), { recursive: true, mode: 0o700 })
  try {
    renameSync(home, path.join(root, COLLECTED, randomUUID()))
    return true
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return false
    throw error
  }
}

function collectIdle(root: string, now: number, retired: readonly string[]): string[] {
  const cutoff = now - HARNESS_HOME_MAX_IDLE_MS
  return withLedger(root, (db) => {
    db.transaction(() => {
      for (const launchId of retired) {
        const launch = db.prepare<{ home: string }>("SELECT home FROM home_launch WHERE launch_id = ?").get(launchId)
        if (!launch) continue
        recordLastUse(db, launch.home, now)
        db.prepare("DELETE FROM home_launch WHERE launch_id = ?").run(launchId)
      }
    })
    const idle = `SELECT home FROM home_use WHERE last_used < ? AND NOT EXISTS (SELECT 1 FROM home_launch WHERE home_launch.home = home_use.home)`
    const collected: string[] = []
    for (const { home } of db.prepare<{ home: string }>(idle).all(cutoff)) {
      const moved = db.transaction(() => {
        if (!db.prepare(`${idle} AND home = ?`).get(cutoff, home)) return false
        db.prepare("DELETE FROM home_use WHERE home = ?").run(home)
        return setAside(root, home)
      })
      if (moved) collected.push(home)
    }
    return collected
  })
}

async function removeCollected(root: string, deps: HarnessHomeDependencies): Promise<void> {
  const directory = path.join(root, COLLECTED)
  const entries = await readdir(directory).catch((error: unknown) => {
    if (isRecord(error) && error.code === "ENOENT") return []
    throw error
  })
  const failures: unknown[] = []
  for (const entry of entries) {
    try { await deps.remove(path.join(directory, entry)) }
    catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, `${failures.length} collected harness homes under ${directory} could not be removed`)
}

export async function sweepHarnessHomeRoot(root: string, now: number, deps: HarnessHomeDependencies = defaults): Promise<string[]> {
  if (!existsSync(path.join(root, ".usage.sqlite"))) return []
  const collected = collectIdle(root, now, await retiredLaunches(root, deps))
  await removeCollected(root, deps)
  return collected
}
