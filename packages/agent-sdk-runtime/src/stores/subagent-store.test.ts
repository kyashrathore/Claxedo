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

  test("memory snapshots preserve terminal status after a late active observation", () => {
    const store = new MemoryRuntimeStore()
    const spawn = admit(store)
    store.admit({
      parentSessionId: "parent",
      observation: {
        observationId: "completed",
        harnessExecutionId: "run",
        subagentKey: spawn.event.subagentKey,
        status: "completed",
      },
      allocateKey: () => "unused",
    })
    store.admit({
      parentSessionId: "parent",
      observation: {
        observationId: "late-running",
        harnessExecutionId: "run",
        subagentKey: spawn.event.subagentKey,
        status: "running",
      },
      allocateKey: () => "unused",
    })

    const restored = new MemoryRuntimeStore()
    restored.importSnapshot(store.exportSnapshot())

    expect(restored.listSubagents("parent")).toMatchObject([{
      subagentKey: spawn.event.subagentKey,
      revision: 3,
      status: "completed",
    }])
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
