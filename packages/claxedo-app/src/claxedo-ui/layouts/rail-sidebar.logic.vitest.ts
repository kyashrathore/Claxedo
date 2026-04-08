import { describe, expect, test } from "vitest"
import { loadProcessView, mergeProcessEvent, processAction, processRows, processTone, showCloud, showEmpty } from "./rail-sidebar.logic"

describe("showEmpty", () => {
  test("hides empty state when server says more sessions exist", () => {
    expect(showEmpty(0, 0, true)).toBe(false)
  })

  test("hides empty state when rows are filtered out but workspace still has sessions", () => {
    expect(showEmpty(0, 5, false)).toBe(false)
  })

  test("shows empty state only for truly empty workspaces", () => {
    expect(showEmpty(0, 0, false)).toBe(true)
  })

  test("hides empty state when process rows exist", () => {
    expect(showEmpty(0, 0, false, 2)).toBe(false)
  })
})

describe("loadProcessView", () => {
  test("defaults missing persisted value to show", () => {
    expect(loadProcessView(undefined)).toBe("show")
    expect(loadProcessView({})).toBe("show")
  })

  test("preserves explicit hide", () => {
    expect(loadProcessView({ processes: "hide" })).toBe("hide")
  })
})

describe("processRows", () => {
  test("uses process configs as the source of sidebar rows", () => {
    const rows = processRows(
      [
        { id: "proc-a", name: "Dev server" } as any,
        { id: "proc-b", name: "API watcher" } as any,
      ],
      {},
    )
    expect(rows.map((item) => item.id)).toEqual(["proc-a", "proc-b"])
    expect(rows.map((item) => item.title)).toEqual(["Dev server", "API watcher"])
  })

  test("marks crashed processes for sidebar attention", () => {
    const rows = processRows(
      [{ id: "proc-a", name: "Dev server" } as any],
      {
        "proc-a": { configId: "proc-a", status: "crashed" } as any,
      },
    )
    expect(rows[0]?.attention).toBe(true)
    expect(rows[0]?.status).toBe("crashed")
  })
})

describe("processAction", () => {
  test("uses play for idle and stopped processes", () => {
    expect(processAction("idle")).toMatchObject({ icon: "play", mode: "start" })
    expect(processAction("stopped")).toMatchObject({ icon: "play", mode: "start" })
  })

  test("uses stop for active processes", () => {
    expect(processAction("running")).toMatchObject({ icon: "stop", mode: "stop" })
    expect(processAction("starting")).toMatchObject({ icon: "stop", mode: "stop" })
    expect(processAction("restarting")).toMatchObject({ icon: "stop", mode: "stop" })
  })

  test("uses reset for crashed processes", () => {
    expect(processAction("crashed")).toMatchObject({ icon: "reset", mode: "restart" })
  })
})

describe("processTone", () => {
  test("maps process status to row health tone", () => {
    expect(processTone("running")).toBe("good")
    expect(processTone("starting")).toBe("warn")
    expect(processTone("crashed")).toBe("bad")
    expect(processTone("idle")).toBe("idle")
  })
})

describe("mergeProcessEvent", () => {
  test("clears stale stop regressions after a process is already stopped", () => {
    const stopped = mergeProcessEvent(
      { configId: "proc-a", status: "running", restartCount: 0, ptyId: "pty-1" } as any,
      { type: "process.stopped", configId: "proc-a", exitCode: 0 },
    )
    const next = mergeProcessEvent(stopped as any, {
      type: "process.status",
      configId: "proc-a",
      status: "stopping",
    })
    expect(stopped?.status).toBe("stopped")
    expect(stopped?.ptyId).toBeUndefined()
    expect(next?.status).toBe("stopped")
  })
})

describe("showCloud", () => {
  test("does not mark a local main workspace as cloud just because the project has another cloud workspace", () => {
    expect(
      showCloud({
        worktree: "/ws/main",
        workspaceDir: "/ws/main",
        local: true,
        workspaces: {
          "/ws/cloud": { kind: "cloud" },
        },
      }),
    ).toBe(false)
  })

  test("marks the selected cloud workspace as cloud", () => {
    expect(
      showCloud({
        worktree: "/ws/main",
        workspaceDir: "/ws/cloud",
        local: true,
        workspaces: {
          "/ws/cloud": { kind: "cloud" },
        },
      }),
    ).toBe(true)
  })
})
