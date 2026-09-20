import { afterEach, describe, expect, test } from "bun:test"
import { createEffect, createRoot, on } from "solid-js"
import {
  HOST_AGGREGATE_LANE,
  holdSessionEventScope,
  registerSessionEventStreamLane,
  reportSessionEventStreamClosed,
  reportSessionEventStreamOpen,
  resetSessionEventScope,
  sessionEventScopeId,
  sessionEventStreamsOpen,
  setSessionEventRouteScope,
  whenSessionEventStreamsOpen,
  setSessionEventStreamLaneExpected,
} from "./session-event-scope"

afterEach(() => resetSessionEventScope())

const settled = async (promise: Promise<void>) => {
  let done = false
  void promise.then(() => {
    done = true
  })
  // Two turns: one for the store's effect queue, one for the promise job.
  await Promise.resolve()
  await Promise.resolve()
  return done
}

describe("sessionEventScopeId", () => {
  test("bridges the draft route with the session the composer published", () => {
    expect(sessionEventScopeId()).toBeUndefined()
    holdSessionEventScope("ses_created")
    expect(sessionEventScopeId()).toBe("ses_created")
  })

  test("the route wins once it names a session, so navigating away retargets", () => {
    holdSessionEventScope("ses_created")
    setSessionEventRouteScope("ses_other")
    expect(sessionEventScopeId()).toBe("ses_other")
    setSessionEventRouteScope("  ")
    expect(sessionEventScopeId()).toBe("ses_created")
  })

  test("names the session an ATTACH reached by route, with nothing held", () => {
    // The route is a standing input, not a handoff from the composer: a session
    // this client never created must scope the same streams a created one does.
    setSessionEventRouteScope("ses_attached")
    expect(sessionEventScopeId()).toBe("ses_attached")
  })
})

describe("sessionEventScopeId retargets", () => {
  // The reader reconciles its targets on every wake of `sessionEventScopeId`,
  // and a stream the runtime narrowed to one session is aborted and reopened
  // with no cursor when the session it is retargeted to differs
  // (`retarget` in `claxedo-events.tsx`). `e2e/helpers/mock-runtime.ts`'s
  // `EventBus.drain` serves a cursor-less connection the whole retained log,
  // so a wake that carried a DIFFERENT value for the same session would
  // redeliver every frame already applied — a finished turn's `session.idle`
  // replayed, playing the completion sound a second time. These count the
  // wakes, because one wake per SESSION is the property; one wake per WRITE
  // is the bug.
  const countRetargets = () => {
    const seen: Array<string | undefined> = []
    const dispose = createRoot((dispose) => {
      createEffect(on(sessionEventScopeId, (scope) => {
        seen.push(scope)
      }, { defer: true }))
      return dispose
    })
    return { seen, dispose }
  }

  test("an open pane on a workspace this machine serves retargets once for the session it just created", () => {
    // The measured flow behind the duplicated completion sound. `openSession
    // EventStreams` (composer submit-create-session.ts) holds the created id on
    // every workspace kind — local included, because the hold is not what a
    // local branch would change — and the shell route then publishes the same
    // id when the navigation off the draft lands. One session, two writes.
    const lane = countRetargets()
    holdSessionEventScope("ses_local")
    setSessionEventRouteScope("ses_local")
    expect(lane.seen).toEqual(["ses_local"])
    lane.dispose()
  })

  test("a machine-placed session route retargets once, and again only when the session changes", () => {
    // Same two writes on a relay-backed workspace: a stream the runtime
    // narrowed to one session reopens for another, and a needless reopen
    // costs a whole replayed log.
    const lane = countRetargets()
    holdSessionEventScope("ses_hosted")
    setSessionEventRouteScope("ses_hosted")
    expect(lane.seen).toEqual(["ses_hosted"])

    // A navigation to a different session IS the user moving on, and must
    // retarget the stream.
    setSessionEventRouteScope("ses_next")
    expect(lane.seen).toEqual(["ses_hosted", "ses_next"])

    // Dropping the route back to a draft falls through to the held id, which is
    // a different session again — so this one is a retarget too.
    setSessionEventRouteScope(undefined)
    expect(lane.seen).toEqual(["ses_hosted", "ses_next", "ses_hosted"])
    lane.dispose()
  })
})

describe("sessionEventStreamsOpen", () => {
  test("is satisfied vacuously when no workspace stream is registered and none is owed", () => {
    expect(sessionEventStreamsOpen("ses_1")).toBe(true)
  })

  test("waits for the workspace stream the route is owed while its catalog entry resolves", () => {
    setSessionEventStreamLaneExpected(true)
    expect(sessionEventStreamsOpen("ses_1")).toBe(false)
    const release = registerSessionEventStreamLane("wr:ws_1")
    expect(sessionEventStreamsOpen("ses_1")).toBe(false)
    reportSessionEventStreamOpen("wr:ws_1")
    expect(sessionEventStreamsOpen("ses_1")).toBe(true)
    release()
    setSessionEventStreamLaneExpected(false)
    expect(sessionEventStreamsOpen("ses_1")).toBe(true)
  })

  test("the host aggregate does not stand in for the workspace stream the route is owed", () => {
    // It is registered on every loopback surface and carries every session it
    // has, so counting it would answer an expectation raised for a workspace
    // whose own runtime is another machine's.
    const releaseHost = registerSessionEventStreamLane(HOST_AGGREGATE_LANE)
    reportSessionEventStreamOpen(HOST_AGGREGATE_LANE)
    setSessionEventStreamLaneExpected(true)
    expect(sessionEventStreamsOpen("ses_1")).toBe(false)

    const release = registerSessionEventStreamLane("wr:ws_1")
    reportSessionEventStreamOpen("wr:ws_1")
    expect(sessionEventStreamsOpen("ses_1")).toBe(true)
    release()
    releaseHost()
  })

  test("waits for a registered stream and requires it to carry the session", () => {
    registerSessionEventStreamLane("wr:a")
    expect(sessionEventStreamsOpen("ses_1")).toBe(false)

    reportSessionEventStreamOpen("wr:a", "ses_other")
    expect(sessionEventStreamsOpen("ses_1")).toBe(false)

    reportSessionEventStreamOpen("wr:a", "ses_1")
    expect(sessionEventStreamsOpen("ses_1")).toBe(true)

    reportSessionEventStreamClosed("wr:a")
    expect(sessionEventStreamsOpen("ses_1")).toBe(false)
  })

  test("a workspace-wide stream carries every session, so local needs no scope", () => {
    registerSessionEventStreamLane("wr:b")
    reportSessionEventStreamOpen("wr:b")
    expect(sessionEventStreamsOpen("ses_1")).toBe(true)
    expect(sessionEventStreamsOpen("ses_2")).toBe(true)
  })

  test("the host aggregate carries every local session, whichever workspace it belongs to", () => {
    // On loopback the only stream a workspace has is the daemon's host
    // aggregate, registered under one lane for all of them: readiness that
    // waited for a per-workspace lane would never be satisfied.
    registerSessionEventStreamLane("wr:host")
    expect(sessionEventStreamsOpen("ses_in_repo_a")).toBe(false)
    reportSessionEventStreamOpen("wr:host")
    expect(sessionEventStreamsOpen("ses_in_repo_a")).toBe(true)
    expect(sessionEventStreamsOpen("ses_in_repo_b")).toBe(true)
  })

  test("a released stream stops being waited for", () => {
    const release = registerSessionEventStreamLane("wr:a")
    expect(sessionEventStreamsOpen("ses_1")).toBe(false)
    release()
    expect(sessionEventStreamsOpen("ses_1")).toBe(true)
  })
})

describe("whenSessionEventStreamsOpen", () => {
  test("resolves only once every registered stream carries the session", async () => {
    registerSessionEventStreamLane("wr:b")
    registerSessionEventStreamLane("wr:a")
    const open = whenSessionEventStreamsOpen("ses_1")

    expect(await settled(open)).toBe(false)

    reportSessionEventStreamOpen("wr:b", "ses_1")
    expect(await settled(open)).toBe(false)

    reportSessionEventStreamOpen("wr:a", "ses_1")
    expect(await settled(open)).toBe(true)
    await open
  })

  test("an aborted wait resolves and stops watching the session", async () => {
    registerSessionEventStreamLane("wr:a")
    const give = new AbortController()
    const open = whenSessionEventStreamsOpen("ses_1", { signal: give.signal })

    expect(await settled(open)).toBe(false)
    give.abort()
    expect(await settled(open)).toBe(true)
    await open
  })
})
