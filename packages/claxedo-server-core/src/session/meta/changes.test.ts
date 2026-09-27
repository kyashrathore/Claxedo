import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(realpathSync(os.tmpdir()), `session-meta-changes-${randomUUID().slice(0, 8)}`)
const prev = { CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR, CLAXEDO_STATE_DIR: process.env.CLAXEDO_STATE_DIR }
process.env.CLAXEDO_DATA_DIR = root
process.env.CLAXEDO_STATE_DIR = path.join(root, "state")

const [{ deleteSessionMeta, onSessionMetaChange, putSessionMeta, syncSessionMeta, syncSessionMetas }, { ClaxedoDB }] = await Promise.all([
  import("./index"),
  import("../../platform/db"),
])

const ws = { id: "ws_changes", directory: "/tmp/changes", kind: "local" as const, created_at: 1, updated_at: 1 }

let heard: unknown[]
let unsubscribe: () => void

beforeEach(async () => {
  await fs.mkdir(root, { recursive: true })
  heard = []
  unsubscribe = onSessionMetaChange((change) => heard.push(change))
})

afterEach(async () => {
  unsubscribe()
  ClaxedoDB.close()
  await fs.rm(root, { recursive: true, force: true })
})

afterEach(() => {
  for (const [key, value] of Object.entries(prev)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  process.env.CLAXEDO_DATA_DIR = root
  process.env.CLAXEDO_STATE_DIR = path.join(root, "state")
})

describe("session meta change notices", () => {
  test("a put reports the session under its workspace, and one placed nowhere reports nothing", async () => {
    await putSessionMeta("s1", { workspaceID: ws.id, directory: ws.directory, title: "First" })
    await putSessionMeta("s1", { title: "Renamed" })
    await putSessionMeta("orphan", { directory: "/tmp/elsewhere" })

    expect(heard).toEqual([
      { kind: "changed", workspaceId: ws.id, sessionId: "s1" },
      { kind: "changed", workspaceId: ws.id, sessionId: "s1" },
    ])
  })

  test("a delete reports every row of the tree it removed", async () => {
    await putSessionMeta("root", { ws })
    await putSessionMeta("child", { ws, parentID: "root" })
    await putSessionMeta("grandchild", { ws, parentID: "child" })
    heard.length = 0

    await deleteSessionMeta("root")

    expect(heard.map((change) => (change as { sessionId: string }).sessionId).sort()).toEqual(["child", "grandchild", "root"])
    expect(heard.every((change) => (change as { kind: string; workspaceId: string }).kind === "removed" && (change as { workspaceId: string }).workspaceId === ws.id)).toBe(true)
  })

  test("a synced session reports itself; a synced snapshot reports its workspace once", async () => {
    const time = { created: 1, updated: 2 }
    await syncSessionMeta(ws, { id: "s2", title: "Synced", time })
    expect(heard).toEqual([{ kind: "changed", workspaceId: ws.id, sessionId: "s2" }])

    heard.length = 0
    await syncSessionMetas(ws, [{ id: "s2", time }, { id: "s3", time }])
    expect(heard).toEqual([{ kind: "workspace", workspaceId: ws.id }])

    heard.length = 0
    await syncSessionMetas(undefined, [{ id: "s4", workspaceID: ws.id, time }, { id: "s5", time }])
    expect(heard, "with no workspace to sweep, each placed row reports itself").toEqual([{ kind: "changed", workspaceId: ws.id, sessionId: "s4" }])
  })

  test("a listener that throws never fails the write, and an unsubscribed one hears nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const stop = onSessionMetaChange(() => {
      throw new Error("listener down")
    })
    try {
      await expect(putSessionMeta("s6", { ws })).resolves.toBeUndefined()
      expect(heard).toEqual([{ kind: "changed", workspaceId: ws.id, sessionId: "s6" }])
      expect(warn).toHaveBeenCalledTimes(1)

      stop()
      unsubscribe()
      heard.length = 0
      await putSessionMeta("s7", { ws })
      expect(heard).toEqual([])
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})
