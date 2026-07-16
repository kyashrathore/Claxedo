import { afterEach, describe, expect, test } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { claimDataDirOwnership, DataDirOwnershipError, withDataDirOwnership } from "./data-dir-owner"

const roots: string[] = []

async function activeOwnerPath(root: string) {
  const directory = path.join(root, "control-plane.owners")
  const [owner] = await fs.readdir(directory)
  if (!owner) throw new Error("missing owner claim")
  return path.join(directory, owner)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("data directory ownership", () => {
  test("refuses a second live owner and permits a later owner after release", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-data-owner-"))
    roots.push(root)
    const first = claimDataDirOwnership(root)
    expect(() => claimDataDirOwnership(root)).toThrow(DataDirOwnershipError)
    first.release()
    const second = claimDataDirOwnership(root)
    second.release()
  })

  test("reclaims a stale owner record", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-data-owner-stale-"))
    roots.push(root)
    await fs.writeFile(path.join(root, "control-plane.owner.json"), JSON.stringify({
      pid: 999_999_999,
      hostname: os.hostname(),
      token: "stale",
      startedAt: new Date(0).toISOString(),
    }))
    const owner = claimDataDirOwnership(root)
    owner.release()
  })

  test("release restores a replacement owner instead of deleting it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-data-owner-race-"))
    roots.push(root)
    const owner = claimDataDirOwnership(root)
    const ownerPath = await activeOwnerPath(root)
    await fs.unlink(ownerPath)
    await fs.writeFile(ownerPath, JSON.stringify({
      pid: process.pid,
      hostname: os.hostname(),
      token: "replacement",
      startedAt: new Date().toISOString(),
    }))

    owner.release()

    await expect(fs.readFile(ownerPath, "utf8")).resolves.toContain('"token":"replacement"')
    expect(() => claimDataDirOwnership(root)).toThrow(DataDirOwnershipError)
  })

  test("refuses to guess that an owner from another host is stale", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-data-owner-remote-"))
    roots.push(root)
    await fs.writeFile(path.join(root, "control-plane.owner.json"), JSON.stringify({
      pid: 999_999_999,
      hostname: "another-host",
      token: "remote",
      startedAt: new Date(0).toISOString(),
    }))
    expect(() => claimDataDirOwnership(root)).toThrow(DataDirOwnershipError)
  })

  test("stale cleanup never renames an unrelated live unique claim", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-data-owner-three-way-"))
    roots.push(root)
    await fs.writeFile(path.join(root, "control-plane.owner.json"), JSON.stringify({
      pid: 999_999_999,
      hostname: os.hostname(),
      token: "stale",
      startedAt: new Date(0).toISOString(),
    }))
    const owner = claimDataDirOwnership(root)
    const livePath = await activeOwnerPath(root)

    expect(() => claimDataDirOwnership(root)).toThrow(DataDirOwnershipError)
    await expect(fs.stat(livePath)).resolves.toBeDefined()
    owner.release()
  })

  test("releases ownership when startup composition throws", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-data-owner-startup-"))
    roots.push(root)
    expect(() => withDataDirOwnership(root, () => {
      throw new Error("startup failed")
    })).toThrow("startup failed")
    const retry = claimDataDirOwnership(root)
    retry.release()
  })
})
