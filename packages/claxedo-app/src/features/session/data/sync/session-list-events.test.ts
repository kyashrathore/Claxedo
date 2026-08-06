import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { PermissionRequest, Session, SessionStatus } from "@opencode-ai/sdk/v2/client"
import {
  applyClaxedoSessionLifecycleEvent,
  applyDirectorySessionCacheEvent,
  mergeCanonicalSessionUpdate,
} from "./session-list-events"
import { clearOpenSessions, setOpenSessions } from "@/features/session/store/open-sessions"
import { conversationEventTypes } from "../../conversation/conversation-event"
import { queryClient } from "@/platform/query/query-client"
import { shellDataKeys } from "@/platform/sync/keys"
import { clearAllPromptSessionStatusTimeoutsForTest } from "../../store/session-status-dispatcher"
import type { DirectorySessionCacheValue } from "./queries"

const root = (id: string, archived?: number) =>
  ({
    id,
    time: {
      created: 1,
      updated: 1,
      archived,
    },
  }) as Session

const child = (id: string, parentID: string) =>
  ({
    id,
    parentID,
    time: {
      created: 1,
      updated: 1,
    },
  }) as Session

function cache(input: Partial<DirectorySessionCacheValue> = {}): DirectorySessionCacheValue {
  return {
    at: 1,
    session: [],
    total: 0,
    limit: 1,
    ...input,
  }
}

beforeEach(() => clearOpenSessions())
afterEach(() => {
  clearOpenSessions()
  queryClient.clear()
  clearAllPromptSessionStatusTimeoutsForTest()
})

describe("claxedo applyDirectorySessionCacheEvent", () => {
  test("a mutation response only wins an equal timestamp when the cache still matches its baseline", () => {
    const baseline = { ...root("ses_a"), title: "Original title", time: { created: 1, updated: 30 } }
    const current = { ...root("ses_a"), title: "Newer event title", time: { created: 1, updated: 30 } }
    const older = { ...root("ses_a"), title: "Older mutation title", time: { created: 1, updated: 20 } }
    const conflicting = { ...root("ses_a"), title: "Equal-time mutation title", time: { created: 1, updated: 30 } }
    const newer = { ...root("ses_a"), title: "Canonical mutation title", time: { created: 1, updated: 40 } }

    expect(mergeCanonicalSessionUpdate(baseline, conflicting, baseline)).toMatchObject({
      title: "Equal-time mutation title",
      time: { updated: 30 },
    })
    expect(mergeCanonicalSessionUpdate(current, older, baseline)).toBe(current)
    expect(mergeCanonicalSessionUpdate(current, conflicting, baseline)).toBe(current)
    expect(mergeCanonicalSessionUpdate(current, newer, baseline)).toMatchObject({
      title: "Canonical mutation title",
      time: { updated: 40 },
    })
  })

  test("conversation events are owned by chat state, not the global-sync mirror", () => {
    const current = cache()

    for (const type of conversationEventTypes) {
      const next = applyDirectorySessionCacheEvent({
        event: {
          type,
          properties: {
            info: { id: "msg_chat", sessionID: "ses_chat" },
            part: { id: "part_chat", sessionID: "ses_chat", messageID: "msg_chat" },
            sessionID: "ses_chat",
            messageID: "msg_chat",
            partID: "part_chat",
            delta: "hello",
          },
        },
        cache: current,
        push() {},
        directory: "/tmp/ws",
      })
      expect(next).toBeUndefined()
    }
  })

  test("vcs branch updates do not revive the Solid store VCS mirror", () => {
    const next = applyDirectorySessionCacheEvent({
      event: { type: "vcs.branch.updated", properties: { branch: "feature" } },
      cache: cache(),
      push() {},
      directory: "/tmp/ws",
    })

    expect(next).toBeUndefined()
  })

  test("server instance disposal requeues the directory without upstream reducer fallback", () => {
    const pushes: string[] = []

    const next = applyDirectorySessionCacheEvent({
      event: { type: "server.instance.disposed" },
      cache: cache(),
      push: (directory) => pushes.push(directory),
      directory: "/tmp/ws",
    })

    expect(next).toBeUndefined()
    expect(pushes).toEqual(["/tmp/ws"])
  })

  test("lsp updates do not revive the Solid store LSP mirror", () => {
    const next = applyDirectorySessionCacheEvent({
      event: { type: "lsp.updated" },
      cache: cache(),
      push() {},
      directory: "/tmp/ws",
    })

    expect(next).toBeUndefined()
  })

  test("session.created does not evict an open session outside the trimmed set", () => {
    setOpenSessions([{ directory: "/tmp/ws", sessionId: "ses_z" }])
    queryClient.setQueryData(shellDataKeys.sessionId("ses_z", "todo"), [{ id: "todo_z" }])

    const next = applyDirectorySessionCacheEvent({
      event: { type: "session.created", properties: { info: root("ses_a") } },
      cache: cache({
        session: [root("ses_z")],
        total: 1,
      }),
      push() {},
      directory: "/tmp/ws",
    })

    expect(next?.session.map((item) => item.id)).toEqual(["ses_a"])
    expect(next?.total).toBe(2)
    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_z", "todo"))).toEqual([{ id: "todo_z" }])
  })

  test("session.updated does not evict an open session outside the trimmed set", () => {
    setOpenSessions([{ directory: "/tmp/ws", sessionId: "ses_z" }])
    queryClient.setQueryData(shellDataKeys.sessionId("ses_z", "todo"), [{ id: "todo_z" }])

    const next = applyDirectorySessionCacheEvent({
      event: { type: "session.updated", properties: { info: root("ses_a") } },
      cache: cache({
        session: [root("ses_z")],
        total: 1,
      }),
      push() {},
      directory: "/tmp/ws",
    })

    expect(next?.session.map((item) => item.id)).toEqual(["ses_a"])
    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_z", "todo"))).toEqual([{ id: "todo_z" }])
  })

  // REGRESSION. The runtime's auto-title publishes `buildSession(...)` — a
  // PARTIAL row: id/slug/directory/title/version/time and no `config`. This
  // branch used to assign it over the cached row wholesale, erasing
  // `config.model`; the composer reads exactly that field
  // (`submit.ts`, `parseExistingSessionConfig(input.info()?.config)`) and then
  // refused every further prompt in an already-open session with the
  // "Select an agent and model" toast. Reproduced in the running app the
  // moment `session.updated` started being delivered at all.
  test("session.updated merges over the cached row instead of erasing fields it omits", () => {
    const cached = {
      ...root("ses_a"),
      config: { model: { providerID: "claude-sdk", modelID: "default" } },
    } as Session & { config: unknown }

    const next = applyDirectorySessionCacheEvent({
      event: {
        type: "session.updated",
        // Exactly the shape the auto-title sends: a new title, no `config`.
        properties: { info: { ...root("ses_a"), title: "Say FIXPROBE and nothing else." } },
      },
      cache: cache({ session: [cached], total: 1 }),
      push() {},
      directory: "/tmp/ws",
    })

    const row = next?.session.find((item) => item.id === "ses_a") as (Session & { config?: unknown }) | undefined
    expect(row?.title).toBe("Say FIXPROBE and nothing else.")
    // The field the frame never mentioned must survive.
    expect(row?.config).toEqual({ model: { providerID: "claude-sdk", modelID: "default" } })
  })

  test("older created and updated events cannot regress a cached title", () => {
    const current = { ...root("ses_a"), title: "Current title", time: { created: 1, updated: 30 } }
    const older = { ...root("ses_a"), title: "Stale title", time: { created: 1, updated: 20 } }

    for (const type of ["session.created", "session.updated"]) {
      const next = applyDirectorySessionCacheEvent({
        event: { type, properties: { info: older } },
        cache: cache({ session: [current], total: 1 }),
        push() {},
        directory: "/tmp/ws",
      })
      expect(next?.session[0]).toBe(current)
    }
  })

  test("session.created and a not-yet-present session.updated trim identically (shared insert path)", () => {
    // Both branches feed the same splice+trim+cleanup helper, so for an
    // identical starting cache + incoming row they must produce the same
    // trimmed session list — guarding against the two branches re-diverging.
    const base = () =>
      cache({
        session: [root("ses_z"), root("ses_y")],
        total: 2,
        limit: 1,
      })

    const created = applyDirectorySessionCacheEvent({
      event: { type: "session.created", properties: { info: root("ses_a") } },
      cache: base(),
      push() {},
      directory: "/tmp/ws",
    })
    const updated = applyDirectorySessionCacheEvent({
      event: { type: "session.updated", properties: { info: root("ses_a") } },
      cache: base(),
      push() {},
      directory: "/tmp/ws",
    })

    expect(created?.session.map((item) => item.id)).toEqual(["ses_a"])
    expect(updated?.session.map((item) => item.id)).toEqual(created?.session.map((item) => item.id))
  })

  test("claxedo session lifecycle created event inserts session without owning status", () => {
    queryClient.setQueryData<SessionStatus>(shellDataKeys.sessionId("ses_created", "status"), { type: "busy" })

    const next = applyClaxedoSessionLifecycleEvent({
      event: {
        type: "session.lifecycle",
        phase: "created",
        directory: "/tmp/ws",
        sessionID: "ses_created",
        info: root("ses_created"),
        ts: 1_000,
      },
      cache: cache(),
      push() {},
      directory: "/tmp/ws",
    })

    expect(next?.session.map((item) => item.id)).toEqual(["ses_created"])
    expect(next?.total).toBe(1)
    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_created", "status"))).toEqual({ type: "busy" })
  })

  test("claxedo session lifecycle failed event is a reducer no-op (rubric C5: owned by submit wrapper)", () => {
    queryClient.setQueryData<SessionStatus>(shellDataKeys.sessionId("draft_session", "status"), { type: "busy" })

    const next = applyClaxedoSessionLifecycleEvent({
      event: {
        type: "session.lifecycle",
        phase: "failed",
        directory: "/tmp/ws",
        sessionID: "draft_session",
        message: "create failed",
        ts: 1_000,
      },
      cache: cache(),
      push() {},
      directory: "/tmp/ws",
    })

    expect(next).toBeUndefined()
    expect(queryClient.getQueryData(shellDataKeys.sessionId("draft_session", "status"))).toEqual({ type: "busy" })
  })

  test("claxedo session lifecycle ignores events for other directories", () => {
    const next = applyClaxedoSessionLifecycleEvent({
      event: {
        type: "session.lifecycle",
        phase: "created",
        directory: "/other/ws",
        sessionID: "ses_other",
        info: root("ses_other"),
        ts: 1_000,
      },
      cache: cache(),
      push() {},
      directory: "/tmp/ws",
    })

    expect(next).toBeUndefined()
  })
})

describe("claxedo shell query projections", () => {
  test("trimming keeps child sessions protected by shell request query permissions", () => {
    const permission = {
      id: "perm_child",
      sessionID: "ses_child",
      permission: "edit",
      patterns: [],
      metadata: {},
      always: [],
    } as PermissionRequest
    queryClient.setQueryData(shellDataKeys.sessionId("ses_child", "requests"), {
      permissions: [permission],
      questions: [],
    })

    const next = applyDirectorySessionCacheEvent({
      event: { type: "session.created", properties: { info: child("ses_child", "ses_missing_root") } },
      cache: cache({
        session: [root("ses_root")],
        total: 1,
        limit: 1,
      }),
      push: () => {},
      directory: "/tmp/ws",
    })

    expect(next?.session.map((item) => item.id)).toEqual(["ses_child", "ses_root"])
  })
})
