import { describe, expect, test } from "bun:test"
import {
  activeRailSessionStatusTarget,
  boundRailSessionStatusTargets,
  groupRailSessionStatusTargets,
  MAX_RAIL_SESSION_STATUS_TARGETS,
  pruneRailSessionActivityMap,
  railSessionStatusBatchKey,
  railSessionStatusTargetChain,
  railSessionStatusTarget,
} from "./rail-session-status-target"
import {
  invalidateSidebarSessionStatusGroupsForSession,
  sidebarSessionStatusBatches,
} from "./rail-sidebar-status"

describe("rail session status targets", () => {
  test("bounds metadata observers to visible-rail capacity and deduplicates placements", () => {
    const targets = Array.from({ length: MAX_RAIL_SESSION_STATUS_TARGETS + 20 }, (_, index) => ({
      key: `central:ses_${index}`,
      directory: "/repo",
      sessionID: `ses_${index}`,
    }))
    targets.splice(1, 0, targets[0]!)

    const bounded = boundRailSessionStatusTargets(targets)

    expect(bounded).toHaveLength(MAX_RAIL_SESSION_STATUS_TARGETS)
    expect(new Set(bounded.map((target) => target.key)).size).toBe(MAX_RAIL_SESSION_STATUS_TARGETS)
    expect(bounded[0]?.sessionID).toBe("ses_0")
    expect(bounded.at(-1)?.sessionID).toBe(`ses_${MAX_RAIL_SESSION_STATUS_TARGETS - 1}`)
  })

  test("keeps the active placement inside the cap even when it is ordered last", () => {
    const targets = Array.from({ length: MAX_RAIL_SESSION_STATUS_TARGETS + 1 }, (_, index) => ({
      key: `central:ses_${index}`,
      directory: "/repo",
      sessionID: `ses_${index}`,
    }))
    const active = targets.at(-1)!

    const bounded = boundRailSessionStatusTargets(targets, undefined, active.key)

    expect(bounded).toHaveLength(MAX_RAIL_SESSION_STATUS_TARGETS)
    expect(bounded[0]).toBe(active)
    expect(bounded).toContain(active)
  })

  test("prunes retained status and request payloads outside the bounded target set", () => {
    const retainedRequests = [{ id: "permission-heavy" }]
    const current = {
      "central:visible": retainedRequests,
      "central:collapsed": retainedRequests,
      "central:filtered": retainedRequests,
    }

    const next = pruneRailSessionActivityMap(current, [{ key: "central:visible" }])

    expect(next).toEqual({ "central:visible": retainedRequests })
    expect(next).not.toBe(current)
    expect(pruneRailSessionActivityMap(next, [{ key: "central:visible" }])).toBe(next)
  })

  test("selects active priority by canonical workspace placement, not id and directory alone", () => {
    const targets = [
      { key: "workspace:ws_1:session:shared", directory: "/repo", sessionID: "shared", workspaceId: "ws_1" },
      { key: "workspace:ws_2:session:shared", directory: "/repo", sessionID: "shared", workspaceId: "ws_2" },
    ]

    expect(activeRailSessionStatusTarget({
      targets,
      sessionID: "shared",
      directory: "/repo",
      host: "workspace",
      workspaceId: "ws_2",
    }))?.toBe(targets[1])
  })

  test("retains explicit workspace identity for workspace-hosted rows", () => {
    expect(
      railSessionStatusTarget({
        key: "workspace:ws_signed:session:ses_1",
        sessionRef: "workspace:ws_signed:session:ses_1",
        sessionID: "ses_1",
        directory: "/runtime/repo",
        workspaceId: "ws_signed",
      }),
    ).toEqual({
      key: "workspace:ws_signed:session:ses_1",
      sessionID: "ses_1",
      directory: "/runtime/repo",
      workspaceId: "ws_signed",
    })
  })

  test("does not treat a central session workspace association as runtime placement", () => {
    expect(
      railSessionStatusTarget({
        key: "central:ses_1",
        sessionRef: "central:ses_1",
        sessionID: "ses_1",
        directory: "/runtime/repo",
        workspaceId: "ws_associated",
      }),
    ).toEqual({
      key: "central:ses_1",
      sessionID: "ses_1",
      directory: "/runtime/repo",
    })
  })

  test("keeps distinct workspace placements in separate polling batches", () => {
    const groups = groupRailSessionStatusTargets([
      railSessionStatusTarget({
        key: "workspace:ws_2:session:shared",
        sessionRef: "workspace:ws_2:session:shared",
        sessionID: "shared",
        directory: "/runtime/repo",
        workspaceId: "ws_2",
      }),
      railSessionStatusTarget({
        key: "workspace:ws_1:session:shared",
        sessionRef: "workspace:ws_1:session:shared",
        sessionID: "shared",
        directory: "/runtime/repo",
        workspaceId: "ws_1",
      }),
    ])

    expect(
      groups.map((group) => ({
        workspaceId: group.workspaceId,
        batchKey: railSessionStatusBatchKey(group),
      })),
    ).toEqual([
      { workspaceId: "ws_1", batchKey: "ws_1\0/runtime/repo\0shared" },
      { workspaceId: "ws_2", batchKey: "ws_2\0/runtime/repo\0shared" },
    ])
  })

  test("an id-only activity event invalidates every duplicate-id placement for refetch", () => {
    const groups = groupRailSessionStatusTargets([
      railSessionStatusTarget({
        key: "workspace:ws_1:session:shared",
        sessionRef: "workspace:ws_1:session:shared",
        sessionID: "shared",
        directory: "/runtime/repo",
        workspaceId: "ws_1",
      }),
      railSessionStatusTarget({
        key: "workspace:ws_2:session:shared",
        sessionRef: "workspace:ws_2:session:shared",
        sessionID: "shared",
        directory: "/runtime/repo",
        workspaceId: "ws_2",
      }),
      railSessionStatusTarget({
        key: "workspace:ws_3:session:other",
        sessionRef: "workspace:ws_3:session:other",
        sessionID: "other",
        directory: "/runtime/repo",
        workspaceId: "ws_3",
      }),
    ])
    const aborts = groups.map(() => ({ called: false }))
    groups.forEach((group, index) => {
      sidebarSessionStatusBatches.set(railSessionStatusBatchKey(group), {
        updatedAt: Date.now(),
        controller: { abort: () => { aborts[index]!.called = true } } as AbortController,
      })
    })

    expect(invalidateSidebarSessionStatusGroupsForSession(groups, "shared")).toBe(2)
    expect(aborts.map((item) => item.called)).toEqual([true, true, false])
    expect(groups.map((group) => sidebarSessionStatusBatches.has(railSessionStatusBatchKey(group))))
      .toEqual([false, false, true])

    sidebarSessionStatusBatches.clear()
  })
})

describe("railSessionStatusTargetChain", () => {
  const targets = [
    { key: "central:ses_b", directory: "/w", sessionID: "ses_b" },
    { key: "workspace:ws_1:ses_a", directory: "/w", sessionID: "ses_a", workspaceId: "ws_1" },
  ]
  const chain = (over: Partial<Parameters<typeof railSessionStatusTargetChain>[0]> = {}) =>
    railSessionStatusTargetChain({
      targets: () => targets,
      focusedSessionRef: () => undefined,
      activeSessionID: () => undefined,
      activeDirectory: () => undefined,
      ...over,
    })

  test("the focused row is the one matching the active session and its placement", () => {
    const derived = chain({
      focusedSessionRef: () => ({ host: "workspace", workspaceId: "ws_1" }) as never,
      activeSessionID: () => "ses_a",
      activeDirectory: () => "/w",
    })

    expect(derived.focused()?.key).toBe("workspace:ws_1:ses_a")
  })

  test("groups and signature follow the bounded rows", () => {
    const derived = chain()

    expect(derived.groups().map((group) => group.targets.map((target) => target.sessionID)))
      .toEqual([["ses_b"], ["ses_a"]])
    expect(derived.signature()).toBe(
      derived.groups().map((group) => railSessionStatusBatchKey(group)).join("\n"),
    )
  })

  test("no focused row still yields every group", () => {
    expect(chain().focused()).toBeUndefined()
    expect(chain().bounded()).toHaveLength(2)
  })
})
