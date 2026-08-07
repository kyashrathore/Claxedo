import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { MemoryRuntimeStore } from "./memory"
import { SqliteRuntimeStore } from "./sqlite"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function admit(store: MemoryRuntimeStore) {
  return store.admit({
    parentSessionId: "parent",
    observation: {
      observationId: "spawn",
      harnessExecutionId: "run",
      toolCallId: "tool-1",
      toolCallRole: "spawn",
      status: "running",
      transcript: { kind: "live", ref: "child-handle" },
    },
    allocateKey: () => "host-child",
  })
}

describe("runtime subagent admission stores", () => {
  test("memory snapshots preserve identity, revisions, and publish state", () => {
    const store = new MemoryRuntimeStore()
    const first = admit(store)
    store.markPublished("parent", "spawn")

    const restored = new MemoryRuntimeStore()
    restored.importSnapshot(store.exportSnapshot())
    const replay = admit(restored)

    expect(replay).toEqual({ ...first, published: true })
    expect(restored.listSubagentEvents("parent")).toEqual([first.event])
  })

  test("sqlite snapshots preserve admission across reopen", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runtime-subagent-"))
    roots.push(root)
    const firstStore = new SqliteRuntimeStore({ root })
    const first = admit(firstStore)
    firstStore.markPublished("parent", "spawn")
    firstStore.close()

    const reopened = new SqliteRuntimeStore({ root })
    const replay = admit(reopened)

    expect(replay).toEqual({ ...first, published: true })
    expect(reopened.listSubagentEvents("parent")).toEqual([first.event])
    reopened.close()
  })
})
