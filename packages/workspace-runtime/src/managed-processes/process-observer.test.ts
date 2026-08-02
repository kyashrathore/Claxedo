import { describe, expect, test } from "bun:test"

import { createProcessObserver, type ProcessObserverEvent } from "./process-observer"

describe("process observer", () => {
  test("publishes only safe ownership metadata and tracks observed lifetime", () => {
    const events: ProcessObserverEvent[] = []
    let now = 100
    const observer = createProcessObserver({ sink: (event) => events.push(event), now: () => now })
    const handle = observer.register(
      {
        ownerId: "pty-1",
        ownerGeneration: "generation-1",
        launchId: "launch-1",
        kind: "pty",
        role: "pty",
        label: "Terminal\u0000secret",
        pid: 42,
        workspaceId: "workspace-1",
        directory: "/tmp/workspace",
        sessionId: "session-1",
      },
      { stopGracefully: async () => undefined },
    )

    now = 175
    handle.exit({ reason: "exited", exitCode: 0 })

    expect(events).toEqual([
      {
        type: "registered",
        at: 100,
        descriptor: {
          ownerId: "pty-1",
          ownerGeneration: "generation-1",
          launchId: "launch-1",
          kind: "pty",
          role: "pty",
          label: "Terminal secret",
          pid: 42,
          workspaceId: "workspace-1",
          directory: "/tmp/workspace",
          sessionId: "session-1",
        },
        capabilities: { stopGracefully: true, killOwnedTree: false },
      },
      {
        type: "exited",
        at: 175,
        ownerId: "pty-1",
        ownerGeneration: "generation-1",
        reason: "exited",
        exitCode: 0,
        observedLifetimeMs: 75,
      },
    ])
    expect(JSON.stringify(events)).not.toContain("sentinel-secret")
  })

  test("fails reused PID and stale owner generations closed", async () => {
    const observer = createProcessObserver()
    observer.register(
      {
        ownerId: "shell-1",
        ownerGeneration: "generation-1",
        launchId: "launch-1",
        kind: "session-shell",
        role: "session-shell",
        label: "Session shell",
        pid: 10,
      },
      { killOwnedTree: async () => undefined },
    )

    expect(
      observer.update({
        ownerId: "shell-1",
        ownerGeneration: "generation-1",
        pid: 11,
        lifecycle: "ready",
      }),
    ).toBeFalse()
    expect(
      await observer.invoke({
        ownerId: "shell-1",
        ownerGeneration: "generation-2",
        operation: "kill",
      }),
    ).toBe("owner-unavailable")
  })

  test("rejects contradictory owner kind and role", () => {
    const observer = createProcessObserver()
    expect(() =>
      observer.register({
        ownerId: "pty-1",
        ownerGeneration: "generation-1",
        launchId: "launch-1",
        kind: "pty",
        role: "harness",
        label: "Terminal",
      })
    ).toThrow("role must match")
  })

  test("rejects overlong identifiers instead of merging them by truncation", () => {
    const observer = createProcessObserver()
    const shared = "x".repeat(256)

    expect(() =>
      observer.register({
        ownerId: `${shared}-first`,
        ownerGeneration: "generation-1",
        launchId: "launch-1",
        kind: "pty",
        role: "pty",
        label: "Terminal",
      })
    ).toThrow("must not exceed 256")
    expect(() =>
      observer.register({
        ownerId: `${shared}-second`,
        ownerGeneration: "generation-2",
        launchId: "launch-2",
        kind: "pty",
        role: "pty",
        label: "Terminal",
      })
    ).toThrow("must not exceed 256")
  })

  test("detaching removes owner operations without fabricating another capability", async () => {
    const observer = createProcessObserver()
    const handle = observer.register(
      {
        ownerId: "managed-1",
        ownerGeneration: "generation-1",
        launchId: "launch-1",
        kind: "managed-process",
        role: "managed-process",
        label: "Managed process",
      },
      { stopGracefully: async () => undefined },
    )

    handle.update({ lifecycle: "detached" })

    expect(
      await observer.invoke({
        ownerId: "managed-1",
        ownerGeneration: "generation-1",
        operation: "stop",
      }),
    ).toBe("operation-unavailable")
  })

  test("coalesces repeated lifecycle updates without losing a PID transition", () => {
    const events: ProcessObserverEvent[] = []
    const observer = createProcessObserver({ sink: (event) => events.push(event) })
    const handle = observer.register({
      ownerId: "harness-1",
      ownerGeneration: "generation-1",
      launchId: "launch-1",
      kind: "harness",
      role: "harness",
      label: "CLI harness",
    })

    handle.update({ lifecycle: "starting" })
    handle.update({ lifecycle: "ready", pid: 42 })
    handle.update({ lifecycle: "ready", pid: 42 })
    handle.update({ lifecycle: "ready" })

    expect(events.filter((event) => event.type === "updated")).toEqual([{
      type: "updated",
      at: expect.any(Number),
      ownerId: "harness-1",
      ownerGeneration: "generation-1",
      lifecycle: "ready",
      pid: 42,
    }])
  })

  test("runtime disposal detaches every live owner in only that workspace", async () => {
    const events: ProcessObserverEvent[] = []
    const observer = createProcessObserver({ sink: (event) => events.push(event) })
    for (const workspaceId of ["workspace-a", "workspace-b"]) {
      observer.register(
        {
          ownerId: `pty-${workspaceId}`,
          ownerGeneration: "generation-1",
          launchId: `launch-${workspaceId}`,
          kind: "pty",
          role: "pty",
          label: "Terminal",
          pid: workspaceId === "workspace-a" ? 10 : 11,
          workspaceId,
        },
        { stopGracefully: async () => undefined },
      )
    }

    expect(observer.detachWorkspace("workspace-a")).toBe(1)
    expect(
      events.filter((event) => event.type === "updated" && event.lifecycle === "detached"),
    ).toEqual([
      {
        type: "updated",
        at: expect.any(Number),
        ownerId: "pty-workspace-a",
        ownerGeneration: "generation-1",
        pid: 10,
        lifecycle: "detached",
      },
    ])
    expect(
      await observer.invoke({
        ownerId: "pty-workspace-a",
        ownerGeneration: "generation-1",
        operation: "stop",
      }),
    ).toBe("operation-unavailable")
    expect(
      await observer.invoke({
        ownerId: "pty-workspace-b",
        ownerGeneration: "generation-1",
        operation: "stop",
      }),
    ).toBe("completed")
  })
})
