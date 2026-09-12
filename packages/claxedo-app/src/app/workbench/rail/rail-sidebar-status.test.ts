import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { AgentRuntimeStatus as SessionStatus } from "@claxedo/agent-runtime-contract"
import { queryClient } from "@/platform/query/query-client"
import { shellDataKeys } from "@/platform/sync/keys"
import {
  dispatchSessionStatusEvent,
  promptSessionStatusMeta,
} from "@/features/session/store/session-status-dispatcher"
import { applyDirectorySessionMeta } from "@/features/session/store/directory-session-meta"
import { applyDirectoryEventToShellQueries } from "@/features/session/data/sync/directory-event-projector"
import {
  SIDEBAR_SESSION_STATUS_FRESH_MS,
  abortSidebarSessionStatusBatches,
  mergeRailRequestRead,
  mergeRailStatusRead,
  pruneSidebarSessionStatusBatches,
  publishFocusedRailSessionMeta,
  railBatchData,
  readRailBatchLeg,
  shouldAcceptRailBatchStatus,
  sidebarSessionStatusBatches,
  stampRailStatusRead,
  syncUnfocusedRailBatchStatusToCache,
} from "./rail-sidebar-status"
import {
  activateDisclosureFromKeyboard,
  indexUnambiguousSessionStatusTargets,
  isDisclosureToggleKey,
  isRootWorktreeRef,
  sessionRowTitle,
  primedSessionStatusType,
  mergedSessionStatusType,
  railRowStatusType,
  unambiguousSessionStatusTarget,
} from "./rail-sidebar.logic"

describe("unambiguousSessionStatusTarget", () => {
  test("returns a unique visible placement", () => {
    const target = { key: "workspace:one", sessionID: "ses_1" }
    expect(unambiguousSessionStatusTarget([target, { key: "workspace:two", sessionID: "ses_2" }], "ses_1")).toBe(target)
  })

  test("refuses to invent placement authority for duplicate ids", () => {
    expect(unambiguousSessionStatusTarget([
      { key: "workspace:one", sessionID: "shared" },
      { key: "workspace:two", sessionID: "shared" },
    ], "shared")).toBeUndefined()
  })
})

describe("indexUnambiguousSessionStatusTargets", () => {
  test("indexes unique ids and omits every duplicate placement", () => {
    const unique = { key: "workspace:one", sessionID: "unique" }
    const indexed = indexUnambiguousSessionStatusTargets([
      unique,
      { key: "workspace:one", sessionID: "shared" },
      { key: "workspace:two", sessionID: "shared" },
    ])

    expect(indexed.get("unique")).toBe(unique)
    expect(indexed.has("shared")).toBe(false)
  })
})

describe("primedSessionStatusType", () => {
  test("preserves canonical busy state instead of replacing it with idle", () => {
    expect(primedSessionStatusType({ type: "busy" })).toBe("busy")
    expect(primedSessionStatusType()).toBe("idle")
  })
})

describe("mergedSessionStatusType", () => {
  test("prefers live busy over a stale batch idle", () => {
    expect(mergedSessionStatusType("idle", "busy")).toBe("busy")
  })

  test("preserves batch busy when live is absent", () => {
    expect(mergedSessionStatusType("busy", undefined)).toBe("busy")
  })

  test("falls back to live idle when batch is absent", () => {
    expect(mergedSessionStatusType(undefined, "idle")).toBe("idle")
  })
})

describe("railRowStatusType", () => {
  test("a background row renders its own optimistic busy until a later batch read answers", () => {
    // B7's shape: the send writes optimistic busy at t=100, the newest batch
    // read was issued at t=50 and therefore never saw the turn.
    expect(railRowStatusType({
      batchType: undefined,
      liveType: "busy",
      focused: false,
      optimisticStartedAt: 100,
      batchReadStartedAt: 50,
    })).toBe("busy")
  })

  test("a background row with no batch read yet still renders its optimistic busy", () => {
    expect(railRowStatusType({
      batchType: undefined,
      liveType: "busy",
      focused: false,
      optimisticStartedAt: 100,
    })).toBe("busy")
  })

  test("a batch read issued after the send retires the optimistic busy", () => {
    // The unseen-done dot depends on this transition: the row must be allowed
    // back to idle once an authority that could see the turn says so.
    expect(railRowStatusType({
      batchType: undefined,
      liveType: "busy",
      focused: false,
      optimisticStartedAt: 100,
      batchReadStartedAt: 150,
    })).toBeUndefined()
  })

  test("a background row with no optimistic dispatch still follows the batch alone", () => {
    expect(railRowStatusType({ batchType: undefined, liveType: "busy", focused: false })).toBeUndefined()
    expect(railRowStatusType({ batchType: "busy", liveType: undefined, focused: false })).toBe("busy")
  })

  test("the focused row always merges its own live status", () => {
    expect(railRowStatusType({
      batchType: "idle",
      liveType: "busy",
      focused: true,
      optimisticStartedAt: 100,
      batchReadStartedAt: 150,
    })).toBe("busy")
  })
})

describe("stampRailStatusRead", () => {
  test("stamps every target of the read and returns the same reference when nothing moved", () => {
    const stamped = stampRailStatusRead({}, [{ key: "a" }, { key: "b" }], 42)
    expect(stamped).toEqual({ a: 42, b: 42 })
    expect(stampRailStatusRead(stamped, [{ key: "a" }, { key: "b" }], 42)).toBe(stamped)
    expect(stampRailStatusRead(stamped, [{ key: "a" }], 99)).toEqual({ a: 99, b: 42 })
  })
})

describe("sessionRowTitle", () => {
  test("fresh concrete inventory beats a stale projected placeholder", () => {
    expect(sessionRowTitle(
      "Usage limit is not working",
      "New Session",
      20,
    )).toBe("Usage limit is not working")
  })
})

describe("isRootWorktreeRef", () => {
  test("treats workspace ids that resolve to the project worktree as root", () => {
    expect(isRootWorktreeRef({
      dir: "workspace-main-id",
      projectWorktree: "/repo/main",
      workspace: {
        id: "workspace-main-id",
        directory: "/repo/main",
      },
    })).toBe(true)
  })

  test("allows non-root worktree refs", () => {
    expect(isRootWorktreeRef({
      dir: "workspace-feature-id",
      projectWorktree: "/repo/main",
      workspace: {
        id: "workspace-feature-id",
        directory: "/repo/feature",
      },
    })).toBe(false)
  })
})

describe("isDisclosureToggleKey", () => {
  test("accepts keyboard activation keys for role=button disclosure controls", () => {
    expect(isDisclosureToggleKey("Enter")).toBe(true)
    expect(isDisclosureToggleKey(" ")).toBe(true)
    expect(isDisclosureToggleKey("Space")).toBe(false)
    expect(isDisclosureToggleKey("ArrowRight")).toBe(false)
  })

  test("activates disclosure without leaking the keyboard event to the row", () => {
    const calls: string[] = []

    activateDisclosureFromKeyboard({
      key: "Enter",
      preventDefault: () => calls.push("prevent"),
      stopPropagation: () => calls.push("stop"),
    }, () => calls.push("toggle"))

    activateDisclosureFromKeyboard({
      key: "ArrowRight",
      preventDefault: () => calls.push("prevent-arrow"),
      stopPropagation: () => calls.push("stop-arrow"),
    }, () => calls.push("toggle-arrow"))

    expect(calls).toEqual(["prevent", "stop", "toggle"])
  })
})

describe("sidebar session status batch pruning", () => {
  const fresh = SIDEBAR_SESSION_STATUS_FRESH_MS

  beforeEach(() => {
    sidebarSessionStatusBatches.clear()
  })

  test("drops entries that are past the freshness window", () => {
    const now = 1_000_000
    sidebarSessionStatusBatches.set("dir\0a\0b", { updatedAt: now - fresh - 1 })
    sidebarSessionStatusBatches.set("dir\0a\0b\0c", { updatedAt: now - 1 })

    pruneSidebarSessionStatusBatches(now)

    // The stale one could only ever answer "not fresh", so it can no longer
    // change what the poll does — while the recent one still suppresses a refetch.
    expect(sidebarSessionStatusBatches.has("dir\0a\0b")).toBe(false)
    expect(sidebarSessionStatusBatches.has("dir\0a\0b\0c")).toBe(true)
  })

  test("never drops an entry with a request in flight", () => {
    const now = 1_000_000
    // `updatedAt` starts at 0 while a request is in flight, so an in-flight
    // entry is always "stale" by time — dropping it would lose the de-dupe
    // guard and let the poll fire a duplicate batch request every tick.
    sidebarSessionStatusBatches.set("dir\0a", { updatedAt: 0, inFlight: Promise.resolve() })

    pruneSidebarSessionStatusBatches(now)

    expect(sidebarSessionStatusBatches.has("dir\0a")).toBe(true)
  })

  test("trusted foreground activation aborts every background batch", () => {
    const controller = new AbortController()
    sidebarSessionStatusBatches.set("dir\0a", {
      updatedAt: 10,
      inFlight: new Promise(() => {}),
      controller,
    })

    abortSidebarSessionStatusBatches()

    expect(controller.signal.aborted).toBe(true)
    expect(sidebarSessionStatusBatches.get("dir\0a")).toEqual({ updatedAt: 10 })
  })

  test("collects the permutations left behind by membership churn", () => {
    // The key carries every session id in the group, so each open/close mints
    // a new one and strands its predecessor. Nothing removed them before.
    const now = 1_000_000
    for (let i = 0; i < 200; i++) {
      const ids = Array.from({ length: 20 }, (_, n) => `ses_${i}_${n}`).join("\0")
      sidebarSessionStatusBatches.set(`dir\0${ids}`, { updatedAt: now - fresh - i })
    }
    sidebarSessionStatusBatches.set("dir\0current", { updatedAt: now })

    pruneSidebarSessionStatusBatches(now)

    expect(sidebarSessionStatusBatches.size).toBe(1)
    expect(sidebarSessionStatusBatches.has("dir\0current")).toBe(true)
  })
})

describe("publishFocusedRailSessionMeta", () => {
  const target = (key: string, sessionID: string) => ({ key, directory: "/w", sessionID })
  const group = (targets: ReturnType<typeof target>[]) => ({ directory: "/w", targets })

  test("publishes the focused row's slice of the batch it belongs to", () => {
    const applied: unknown[] = []
    const focused = target("central:ses_a", "ses_a")

    const published = publishFocusedRailSessionMeta({
      focused,
      group: group([focused, target("central:ses_b", "ses_b")]),
      statuses: { ses_a: "busy", ses_b: "idle" },
      permissions: [{ id: "p1" }],
      questions: [{ id: "q1" }],
      apply: (payload) => applied.push(payload),
    })

    expect(published).toBe(true)
    expect(applied).toEqual([{
      sessionID: "ses_a",
      status: { ses_a: "busy", ses_b: "idle" },
      permissions: [{ id: "p1" }],
      questions: [{ id: "q1" }],
    }])
  })

  // These canonical entries are keyed by session id alone, so a group covering
  // some other placement of that session must never write under it -- the
  // focused pane would then render another workspace's status for its own
  // session.
  test("publishes nothing for a group the focused row is not in", () => {
    const applied: unknown[] = []

    const published = publishFocusedRailSessionMeta({
      focused: target("workspace:ws_1:ses_a", "ses_a"),
      group: group([target("workspace:ws_2:ses_a", "ses_a")]),
      statuses: { ses_a: "busy" },
      permissions: [],
      questions: [],
      apply: (payload) => applied.push(payload),
    })

    expect(published).toBe(false)
    expect(applied).toEqual([])
  })

  test("publishes nothing when no row is focused", () => {
    const applied: unknown[] = []

    const published = publishFocusedRailSessionMeta({
      focused: undefined,
      group: group([target("central:ses_a", "ses_a")]),
      statuses: { ses_a: "busy" },
      permissions: [],
      questions: [],
      apply: (payload) => applied.push(payload),
    })

    expect(published).toBe(false)
    expect(applied).toEqual([])
  })

  // The rail batch is the second writer of these canonical entries, so it has
  // to respect a reply the pane's own writer already recorded.
  test("does not re-open the focused row's answered question", () => {
    queryClient.removeQueries({ queryKey: ["shell", "session"] })
    const asked = {
      id: "que_rail",
      sessionID: "ses_rail",
      questions: [{ question: "Keep going?", header: "Next", options: [] }],
    }
    const focused = target("central:ses_rail", "ses_rail")
    applyDirectoryEventToShellQueries({ event: { type: "question.asked", properties: asked }, directory: "/w" })
    applyDirectoryEventToShellQueries({
      event: { type: "question.replied", properties: { sessionID: "ses_rail", requestID: "que_rail" } },
      directory: "/w",
    })

    publishFocusedRailSessionMeta({
      focused,
      group: group([focused]),
      statuses: { ses_rail: { type: "idle" } },
      permissions: [],
      questions: [asked],
      apply: applyDirectorySessionMeta,
    })

    expect(queryClient.getQueryData<{ questions: unknown[] }>(
      shellDataKeys.sessionId("ses_rail", "requests"),
    )?.questions).toEqual([])
  })

  test("publishes successful legs without inventing data for failed legs", () => {
    const applied: unknown[] = []
    const focused = target("central:ses_a", "ses_a")

    publishFocusedRailSessionMeta({
      focused,
      group: group([focused]),
      statuses: { ses_a: "busy" },
      permissions: undefined,
      questions: [{ id: "q1" }],
      apply: (payload) => applied.push(payload),
    })

    expect(applied).toEqual([{
      sessionID: "ses_a",
      status: { ses_a: "busy" },
      permissions: undefined,
      questions: [{ id: "q1" }],
    }])
  })
})

describe("syncUnfocusedRailBatchStatusToCache", () => {
  beforeEach(() => queryClient.clear())

  test("rejects a stale idle poll while optimistic status is in flight", () => {
    dispatchSessionStatusEvent({
      event: {
        type: "session.status",
        source: "optimistic",
        sessionID: "ses_a",
        status: { type: "busy" },
        deadline: Date.now() + 20_000,
      },
    })

    syncUnfocusedRailBatchStatusToCache({
      targets: [{ key: "central:ses_a", sessionID: "ses_a" }],
      statuses: { ses_a: { type: "idle" } },
    })

    expect(queryClient.getQueryData<SessionStatus>(shellDataKeys.sessionId("ses_a", "status"))).toEqual({ type: "busy" })
    expect(promptSessionStatusMeta("ses_a")?.source).toBe("optimistic")
  })

  test("accepts a non-idle poll while optimistic status is in flight", () => {
    dispatchSessionStatusEvent({
      event: {
        type: "session.status",
        source: "optimistic",
        sessionID: "ses_a",
        status: { type: "busy" },
        deadline: Date.now() + 20_000,
      },
    })

    expect(shouldAcceptRailBatchStatus("ses_a", { type: "retry", attempt: 1, message: "", next: 0 })).toBe(true)
  })

  test("accepts an idle read that was issued after the optimistic dispatch", () => {
    dispatchSessionStatusEvent({
      event: {
        type: "session.status",
        source: "optimistic",
        sessionID: "ses_a",
        status: { type: "busy" },
        deadline: Date.now() + 20_000,
      },
    })

    syncUnfocusedRailBatchStatusToCache({
      targets: [{ key: "central:ses_a", sessionID: "ses_a" }],
      statuses: { ses_a: { type: "idle" } },
      readStartedAt: Date.now() + 1_000,
    })

    expect(queryClient.getQueryData<SessionStatus>(shellDataKeys.sessionId("ses_a", "status"))).toEqual({ type: "idle" })
    expect(promptSessionStatusMeta("ses_a")).toBeUndefined()
  })

  test("still rejects an idle read that was already in flight when the prompt was sent", () => {
    const before = Date.now() - 1_000
    dispatchSessionStatusEvent({
      event: {
        type: "session.status",
        source: "optimistic",
        sessionID: "ses_a",
        status: { type: "busy" },
        deadline: Date.now() + 20_000,
      },
    })

    expect(shouldAcceptRailBatchStatus("ses_a", { type: "idle" }, before)).toBe(false)
  })
})

describe("railBatchData", () => {
  test("passes a successful read through, empty payload included", () => {
    expect(railBatchData<Record<string, unknown>>("session status")({ data: {} })).toEqual({})
    expect(railBatchData<{ id: string }[]>("permissions")({ data: [{ id: "p1" }] })).toEqual([{ id: "p1" }])
  })

  test("rejects a failed read instead of substituting an empty payload", () => {
    // Absence from a successful response is the batch's idle assertion. The SDK
    // reports every non-2xx as `data: undefined` too, so treating an unreachable
    // workspace's `data: undefined` the same way would clear every row to idle.
    expect(() => railBatchData("session status")({ data: undefined })).toThrow(/session status unavailable/)
    expect(() => railBatchData("permissions")({})).toThrow(/permissions unavailable/)
  })

  test("settles each read independently so one failed endpoint cannot erase the others", async () => {
    const [status, permissions] = await Promise.all([
      readRailBatchLeg("session status", Promise.resolve({ data: { ses_a: { type: "busy" } } })),
      readRailBatchLeg("permissions", Promise.resolve({ data: undefined })),
    ])

    expect(status).toEqual({ ok: true, value: { ses_a: { type: "busy" } } })
    expect(permissions).toEqual({ ok: false })
  })
})

describe("rail batch projection", () => {
  const targets = [{ key: "central:ses_a", sessionID: "ses_a" }]

  test("preserves failed legs and returns the same reference for a repeated successful leg", () => {
    const current = { "central:ses_a": { questions: [] as { id: string; sessionID: string }[] } }

    const next = mergeRailRequestRead(current, targets, undefined, [])

    expect(next).toBe(current)
  })

  test("projects successful status absence as idle exactly once", () => {
    const current = { "central:ses_a": "busy" }
    const settled = mergeRailStatusRead(current, targets, {})

    expect(settled).toEqual({ "central:ses_a": undefined })
    expect(mergeRailStatusRead(settled, targets, {})).toBe(settled)
  })
})

afterEach(() => { sidebarSessionStatusBatches.clear(); queryClient.clear() })
