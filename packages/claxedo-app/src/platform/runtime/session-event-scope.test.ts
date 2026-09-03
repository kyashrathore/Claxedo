import { afterEach, describe, expect, test } from "bun:test"
import { createEffect, createRoot, on } from "solid-js"
import {
  holdSessionEventScope,
  registerSessionEventStreamLane,
  reportSessionEventStreamClosed,
  reportSessionEventStreamOpen,
  resetSessionEventScope,
  sessionEventScopeId,
  sessionEventStreamsOpen,
  setSessionEventRouteScope,
  whenSessionEventStreamsOpen,
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
  // Both lanes read the scope through `createEffect(on(sessionEventScopeId, …))`
  // and treat every wake as a RETARGET: the stream is aborted and reopened with
  // no cursor. A cursor-less connection is served the whole retained log
  // (`e2e/helpers/mock-runtime.ts`'s `EventBus.drain`, and the compat stream on
  // both real servers), so a wake that names the session the lane already
  // carries redelivers every frame it has already applied — a finished turn's
  // `session.idle` replayed, playing the completion sound a second time. These
  // count the wakes, because one wake per SESSION is the property; one wake per
  // WRITE is the bug.
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

  test("a local workspace's open pane retargets once for the session it just created", () => {
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

  test("a user-hosted session route retargets once, and again only when the session changes", () => {
    // Same two writes on a relay-backed workspace, where the lanes really are
    // session-scoped and a needless reopen costs a whole replayed log.
    const lane = countRetargets()
    holdSessionEventScope("ses_hosted")
    setSessionEventRouteScope("ses_hosted")
    expect(lane.seen).toEqual(["ses_hosted"])

    // A navigation to a different session IS the user moving on, and must
    // retarget both lanes.
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
  test("is satisfied vacuously when no provider drives a lane", () => {
    expect(sessionEventStreamsOpen("ses_1")).toBe(true)
  })

  test("waits for a registered lane and requires it to carry the session", () => {
    registerSessionEventStreamLane("runtime-events")
    expect(sessionEventStreamsOpen("ses_1")).toBe(false)

    reportSessionEventStreamOpen("runtime-events", "ses_other")
    expect(sessionEventStreamsOpen("ses_1")).toBe(false)

    reportSessionEventStreamOpen("runtime-events", "ses_1")
    expect(sessionEventStreamsOpen("ses_1")).toBe(true)

    reportSessionEventStreamClosed("runtime-events")
    expect(sessionEventStreamsOpen("ses_1")).toBe(false)
  })

  test("a workspace-wide stream carries every session, so local needs no scope", () => {
    registerSessionEventStreamLane("workspace-bus")
    reportSessionEventStreamOpen("workspace-bus")
    expect(sessionEventStreamsOpen("ses_1")).toBe(true)
    expect(sessionEventStreamsOpen("ses_2")).toBe(true)
  })

  test("an unregistered lane stops being waited for", () => {
    const release = registerSessionEventStreamLane("runtime-events")
    expect(sessionEventStreamsOpen("ses_1")).toBe(false)
    release()
    expect(sessionEventStreamsOpen("ses_1")).toBe(true)
  })
})

describe("whenSessionEventStreamsOpen", () => {
  test("resolves only once every registered lane carries the session", async () => {
    registerSessionEventStreamLane("workspace-bus")
    registerSessionEventStreamLane("runtime-events")
    const open = whenSessionEventStreamsOpen("ses_1")

    expect(await settled(open)).toBe(false)

    reportSessionEventStreamOpen("workspace-bus", "ses_1")
    expect(await settled(open)).toBe(false)

    reportSessionEventStreamOpen("runtime-events", "ses_1")
    expect(await settled(open)).toBe(true)
    await open
  })

  test("an aborted wait resolves and stops watching the session", async () => {
    registerSessionEventStreamLane("runtime-events")
    const give = new AbortController()
    const open = whenSessionEventStreamsOpen("ses_1", { signal: give.signal })

    expect(await settled(open)).toBe(false)
    give.abort()
    expect(await settled(open)).toBe(true)
    await open
  })
})
