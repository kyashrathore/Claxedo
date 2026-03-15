import { describe, it, expect, beforeEach } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  initWorkGraph,
  getWorkGraph,
  resetWorkGraph,
  linkRun,
  unlinkRun,
  getItemForRun,
  onNodeCompleted,
  onRunCompleted,
  onRunFailed,
  getReadyWork,
} from "../src/workgraph-bridge"

describe("workgraph-bridge", () => {
  beforeEach(() => {
    resetWorkGraph()
  })

  describe("initWorkGraph / getWorkGraph", () => {
    it("should return a WorkGraph instance", () => {
      const wg = initWorkGraph()
      expect(wg).toBeDefined()
    })

    it("should return the same instance on subsequent calls", () => {
      const wg1 = initWorkGraph()
      const wg2 = getWorkGraph()
      expect(wg1).toBe(wg2)
    })

    it("getWorkGraph lazily initializes if not yet created", () => {
      const wg = getWorkGraph()
      expect(wg).toBeDefined()
    })

    it("upgrades a lazy in-memory graph to a persisted file-backed graph", () => {
      const one = getWorkGraph()
      one.create({ title: "Ephemeral" })

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workgraph-bridge-"))
      const db = path.join(dir, "wg.db")
      const two = initWorkGraph(db)

      expect(two).not.toBe(one)
      expect(two.getAll()).toHaveLength(0)

      two.create({ title: "Persisted" })
      resetWorkGraph()

      const three = initWorkGraph(db)
      expect(three.getAll().map((item) => item.title)).toEqual(["Persisted"])
    })
  })

  describe("linkRun / unlinkRun / getItemForRun", () => {
    it("should link a run to a work item", () => {
      const wg = initWorkGraph()
      const item = wg.create({ title: "Test item" })

      linkRun("run_1", item.id)
      const found = getItemForRun("run_1")
      expect(found).toBeDefined()
      expect(found!.id).toBe(item.id)
    })

    it("should return undefined for unlinked run", () => {
      initWorkGraph()
      expect(getItemForRun("run_unknown")).toBeUndefined()
    })

    it("should skip linking if item does not exist", () => {
      initWorkGraph()
      linkRun("run_1", "nonexistent_item")
      expect(getItemForRun("run_1")).toBeUndefined()
    })

    it("should unlink a run", () => {
      const wg = initWorkGraph()
      const item = wg.create({ title: "Test item" })

      linkRun("run_1", item.id)
      expect(getItemForRun("run_1")).toBeDefined()

      unlinkRun("run_1")
      expect(getItemForRun("run_1")).toBeUndefined()
    })

    it("unlinkRun is safe to call on non-linked run", () => {
      initWorkGraph()
      expect(() => unlinkRun("run_nonexistent")).not.toThrow()
    })
  })

  describe("onNodeCompleted", () => {
    it("should transition linked item from open to in_progress", () => {
      const wg = initWorkGraph()
      const item = wg.create({ title: "Task A" })
      expect(item.status).toBe("open")

      linkRun("run_1", item.id)
      onNodeCompleted("run_1")

      const updated = wg.get(item.id)!
      expect(updated.status).toBe("in_progress")
    })

    it("should not change status if already in_progress", () => {
      const wg = initWorkGraph()
      const item = wg.create({ title: "Task B" })
      wg.update(item.id, { status: "in_progress" })

      linkRun("run_1", item.id)
      onNodeCompleted("run_1")

      const updated = wg.get(item.id)!
      expect(updated.status).toBe("in_progress")
    })

    it("should be a no-op for unlinked run", () => {
      initWorkGraph()
      expect(() => onNodeCompleted("run_unknown")).not.toThrow()
    })
  })

  describe("onRunCompleted", () => {
    it("should mark linked item as done", async () => {
      const wg = initWorkGraph()
      const item = wg.create({ title: "Task C" })

      linkRun("run_1", item.id)
      await onRunCompleted("run_1")

      const updated = wg.get(item.id)!
      expect(updated.status).toBe("done")
    })

    it("should unlink the run after completion", async () => {
      const wg = initWorkGraph()
      const item = wg.create({ title: "Task D" })

      linkRun("run_1", item.id)
      await onRunCompleted("run_1")

      expect(getItemForRun("run_1")).toBeUndefined()
    })

    it("should be a no-op for unlinked run", async () => {
      initWorkGraph()
      await expect(onRunCompleted("run_unknown")).resolves.toBeUndefined()
    })
  })

  describe("onRunFailed", () => {
    it("should not change item status (no-op)", () => {
      const wg = initWorkGraph()
      const item = wg.create({ title: "Task E" })

      linkRun("run_1", item.id)
      onNodeCompleted("run_1") // open → in_progress
      onRunFailed("run_1")

      const updated = wg.get(item.id)!
      expect(updated.status).toBe("in_progress")
    })
  })

  describe("getReadyWork", () => {
    it("should return unblocked items without active runs", () => {
      const wg = initWorkGraph()
      const item1 = wg.create({ title: "Ready 1" })
      const item2 = wg.create({ title: "Ready 2" })

      // Link item1 to a run
      linkRun("run_1", item1.id)

      const ready = getReadyWork()
      const readyIds = ready.map((r) => r.id)
      expect(readyIds).toContain(item2.id)
      expect(readyIds).not.toContain(item1.id)
    })

    it("should not return blocked items", () => {
      const wg = initWorkGraph()
      const blocker = wg.create({ title: "Blocker" })
      const blocked = wg.create({ title: "Blocked" })
      wg.addDep(blocker.id, blocked.id)

      const ready = getReadyWork()
      const readyIds = ready.map((r) => r.id)
      expect(readyIds).toContain(blocker.id)
      expect(readyIds).not.toContain(blocked.id)
    })

    it("should return empty when all items have active runs", () => {
      const wg = initWorkGraph()
      const item = wg.create({ title: "Only item" })
      linkRun("run_1", item.id)

      const ready = getReadyWork()
      expect(ready).toHaveLength(0)
    })

    it("should return items unblocked after dependency completes", async () => {
      const wg = initWorkGraph()
      const blocker = wg.create({ title: "Blocker" })
      const blocked = wg.create({ title: "Blocked" })
      wg.addDep(blocker.id, blocked.id)

      // Initially, blocked is not ready
      let ready = getReadyWork()
      expect(ready.map((r) => r.id)).not.toContain(blocked.id)

      // Complete the blocker via run
      linkRun("run_1", blocker.id)
      await onRunCompleted("run_1")

      // Now blocked should be ready
      ready = getReadyWork()
      expect(ready.map((r) => r.id)).toContain(blocked.id)
    })
  })
})
