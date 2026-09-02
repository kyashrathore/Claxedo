import { afterEach, describe, expect, test } from "bun:test"
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
