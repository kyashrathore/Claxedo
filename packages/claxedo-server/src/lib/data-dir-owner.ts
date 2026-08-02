import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"

const OWNER_DIRECTORY = "control-plane.owners"
const LEGACY_OWNER_FILE = "control-plane.owner.json"
const INCOMPLETE_OWNER_STALE_MS = 30_000

type OwnerRecord = Readonly<{
  pid: number
  hostname: string
  token: string
  startedAt: string
}>

type InspectedOwner = Readonly<{
  stat: fs.Stats
  record?: OwnerRecord
}>

export class DataDirOwnershipError extends Error {
  readonly code = "data_dir_already_owned"
  readonly owner: Omit<OwnerRecord, "token"> | undefined

  constructor(owner: OwnerRecord | undefined) {
    super(owner
      ? `Claxedo data directory is already owned by process ${owner.pid} on ${owner.hostname} (since ${owner.startedAt})`
      : "Claxedo data directory has an active ownership claim")
    this.name = "DataDirOwnershipError"
    this.owner = owner
      ? { pid: owner.pid, hostname: owner.hostname, startedAt: owner.startedAt }
      : undefined
  }
}

export function withDataDirOwnership<T>(root: string, start: (owner: ReturnType<typeof claimDataDirOwnership>) => T) {
  const owner = claimDataDirOwnership(root)
  try {
    return start(owner)
  } catch (error) {
    owner.release()
    throw error
  }
}

/**
 * Ownership is additive: every contender creates a unique claim before it
 * inspects existing claims. The later creator must therefore observe the
 * earlier live claim, while stale cleanup can only rename that unique path —
 * never a canonical pathname a new owner could have replaced.
 */
export function claimDataDirOwnership(root: string) {
  if (root === ":memory:") return { release() {} }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const ownerDirectory = path.join(root, OWNER_DIRECTORY)
  fs.mkdirSync(ownerDirectory, { recursive: true, mode: 0o700 })
  const token = randomUUID()
  const ownerPath = path.join(ownerDirectory, `${process.pid}-${token}.json`)
  const handle = fs.openSync(ownerPath, "wx", 0o600)
  const record = {
    pid: process.pid,
    hostname: os.hostname(),
    token,
    startedAt: new Date().toISOString(),
  }
  try {
    fs.writeFileSync(handle, JSON.stringify(record) + "\n")
    fs.fsyncSync(handle)
    const contenders = claimPaths(root, ownerDirectory)
      .flatMap((candidate) => {
        const inspected = inspectOwner(candidate)
        if (!inspected) return []
        if (candidate !== ownerPath && staleOwner(inspected)) {
          removeClaimIfMatches(candidate, inspected)
          return []
        }
        return [{ path: candidate, inspected }]
      })
      .sort((left, right) => {
        const created = left.inspected.stat.birthtimeMs - right.inspected.stat.birthtimeMs
        if (created) return created
        const inode = left.inspected.stat.ino - right.inspected.stat.ino
        if (inode) return inode
        return left.path.localeCompare(right.path)
      })
    if (contenders[0]?.path !== ownerPath) {
      throw new DataDirOwnershipError(contenders[0]?.inspected.record)
    }
  } catch (error) {
    releaseOwned(ownerPath, handle, token)
    fs.closeSync(handle)
    throw error
  }

  let released = false
  return {
    release() {
      if (released) return
      released = true
      try {
        releaseOwned(ownerPath, handle, token)
      } finally {
        fs.closeSync(handle)
      }
    },
  }
}

function claimPaths(root: string, ownerDirectory: string) {
  return [
    ...fs.readdirSync(ownerDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(ownerDirectory, entry.name)),
    path.join(root, LEGACY_OWNER_FILE),
  ]
}

function removeClaimIfMatches(ownerPath: string, inspected: InspectedOwner) {
  const reclaimed = `${ownerPath}.${process.pid}.${randomUUID()}.reclaim`
  try {
    fs.renameSync(ownerPath, reclaimed)
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return
    throw error
  }
  const claimed = inspectOwner(reclaimed)
  if (sameInspectedOwner(claimed, inspected)) {
    fs.unlinkSync(reclaimed)
    return
  }
  restoreClaimedOwner(reclaimed, ownerPath)
}

function releaseOwned(ownerPath: string, handle: number, token: string) {
  const release = `${ownerPath}.${process.pid}.${randomUUID()}.release`
  try {
    fs.renameSync(ownerPath, release)
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return
    throw error
  }
  const claimed = inspectOwner(release)
  const held = fs.fstatSync(handle)
  if (claimed && claimed.stat.dev === held.dev && claimed.stat.ino === held.ino && claimed.record?.token === token) {
    fs.unlinkSync(release)
    return
  }
  restoreClaimedOwner(release, ownerPath)
}

function restoreClaimedOwner(claimed: string, ownerPath: string) {
  try {
    fs.linkSync(claimed, ownerPath)
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error
  }
  if (sameFile(claimed, ownerPath)) fs.unlinkSync(claimed)
}

function inspectOwner(ownerPath: string): InspectedOwner | undefined {
  try {
    const handle = fs.openSync(ownerPath, "r")
    try {
      return { stat: fs.fstatSync(handle), record: parseOwner(fs.readFileSync(handle, "utf8")) }
    } finally {
      fs.closeSync(handle)
    }
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return
    throw error
  }
}

function parseOwner(raw: string): OwnerRecord | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (
      typeof parsed.pid !== "number" || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0 ||
      typeof parsed.hostname !== "string" || !parsed.hostname ||
      typeof parsed.token !== "string" || !parsed.token ||
      typeof parsed.startedAt !== "string" || !parsed.startedAt
    ) return
    return { pid: parsed.pid, hostname: parsed.hostname, token: parsed.token, startedAt: parsed.startedAt }
  } catch {
    return
  }
}

function staleOwner(inspected: InspectedOwner) {
  if (!inspected.record) return Date.now() - inspected.stat.mtimeMs > INCOMPLETE_OWNER_STALE_MS
  if (inspected.record.hostname !== os.hostname()) return false
  try {
    process.kill(inspected.record.pid, 0)
    return false
  } catch (error) {
    return isNodeError(error, "ESRCH")
  }
}

function sameInspectedOwner(left: InspectedOwner | undefined, right: InspectedOwner) {
  return !!left && left.stat.dev === right.stat.dev && left.stat.ino === right.stat.ino &&
    left.record?.token === right.record?.token
}

function sameFile(left: string, right: string) {
  try {
    const leftStat = fs.statSync(left)
    const rightStat = fs.statSync(right)
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false
    throw error
  }
}

function isNodeError(error: unknown, code: string) {
  return !!error && typeof error === "object" && "code" in error && error.code === code
}
