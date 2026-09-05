import { afterEach, describe, expect, it } from "vitest"
import { createRoot, createSignal } from "solid-js"
import { sessionPerf } from "@/platform/performance/session-perf"
import { trackSessionOpen } from "./session-open-perf"

const disposals: Array<() => void> = []

function mountSession(initialId?: string) {
  const [sessionId, setSessionId] = createSignal(initialId)
  const [messagesReady, setMessagesReady] = createSignal(false)
  const [firstFoldReady, setFirstFoldReady] = createSignal(false)
  createRoot((dispose) => {
    disposals.push(dispose)
    trackSessionOpen({
      sessionId,
      directory: () => "/workspace",
      messagesReady,
      firstFoldReady,
      messageCount: () => 12,
    })
  })
  return { setSessionId, setMessagesReady, setFirstFoldReady }
}

afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose()
  sessionPerf.clear()
})

describe("session open performance producer", () => {
  it("starts a direct route before recording phases and starts another open when the route changes", () => {
    const screen = mountSession()
    expect(sessionPerf.events()).toEqual([])

    screen.setSessionId("ses_url")
    screen.setMessagesReady(true)
    screen.setFirstFoldReady(true)
    expect(sessionPerf.events().map((record) => record.name)).toEqual([
      "started", "screen-mounted", "messages-ready", "first-fold-ready",
    ])
    expect(sessionPerf.summary()[0]).toMatchObject({ sessionId: "ses_url", from: "route" })

    screen.setSessionId("ses_next")
    expect(sessionPerf.events().slice(4).map((record) => record.name)).toEqual([
      "started", "screen-mounted", "messages-ready", "first-fold-ready",
    ])
    expect(sessionPerf.summary()[0]).toMatchObject({
      sessionId: "ses_next", from: "route", previousSessionId: "ses_url",
    })
  })

  it("keeps the rail click's start when the session screen mounts", () => {
    sessionPerf.openStart("ses_rail", "rail")
    const startedAt = sessionPerf.summary()[0]!.startedAt
    const screen = mountSession("ses_rail")
    screen.setMessagesReady(true)
    screen.setFirstFoldReady(true)

    expect(sessionPerf.summary()).toEqual([{
      sessionId: "ses_rail",
      from: "rail",
      startedAt,
      phases: {
        "screen-mounted": expect.any(Number),
        "messages-ready": expect.any(Number),
        "first-fold-ready": expect.any(Number),
      },
    }])
    expect(sessionPerf.events().filter((record) => record.name === "started")).toHaveLength(1)
  })
})
