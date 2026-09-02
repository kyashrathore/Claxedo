import { describe, expect, test } from "bun:test"
import type { RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import type { CompatEvent } from "../../compat-events"
import { announcedGoalSnapshot } from "./goal-metadata"
import { OpenCodeGoalMonitors } from "./goal-monitor"
import type { OpenCodeRequestFn } from "./index"

const DIRECTORY = "/workspace"
const SESSION = "ses_goal"

function goal(input: Partial<RuntimeGoalSnapshot> = {}): RuntimeGoalSnapshot {
  return {
    sessionId: SESSION,
    objective: "Prove the loop iterates",
    status: "active",
    createdAt: 1,
    updatedAt: 2,
    iteration: 1,
    ...input,
  }
}

function sessionUpdated(metadata?: Record<string, unknown>) {
  return {
    type: "session.updated",
    properties: {
      info: {
        id: SESSION,
        directory: DIRECTORY,
        title: "Goal session",
        time: { created: 1, updated: 2 },
        ...(metadata ? { metadata } : {}),
      },
    },
  }
}

/** A `/global/event` feed under the test's control: push frames, then end it. */
function feed() {
  const encoder = new TextEncoder()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(next) {
      controller = next
    },
  })
  return {
    request: (async () =>
      new Response(body, { headers: { "content-type": "text/event-stream" } })) as OpenCodeRequestFn,
    emit: (frame: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`)),
    end: () => {
      try {
        controller.close()
      } catch {}
    },
  }
}

function monitors(input: {
  request: OpenCodeRequestFn
  readGoal: () => Promise<RuntimeGoalSnapshot | null>
  published: Array<RuntimeGoalSnapshot | null>
}) {
  return new OpenCodeGoalMonitors({
    request: async () => input.request,
    streamHeaders: () => new Headers(),
    readGoal: input.readGoal,
    publishGoal: (_sessionId, _directory, snapshot) => input.published.push(snapshot),
    observe: () => {},
    publisher: () => () => {},
  })
}

async function settle(check: () => boolean, message: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(message)
}

describe("OpenCodeGoalMonitors", () => {
  test("publishes the terminal Goal the engine announces after its last work turn", async () => {
    const stream = feed()
    const published: Array<RuntimeGoalSnapshot | null> = []
    const monitor = monitors({
      request: stream.request,
      readGoal: async () => goal(),
      published,
    })
    try {
      monitor.start(SESSION, DIRECTORY)
      await settle(() => published.length === 1, "the reconnect read never published the active Goal")

      // The evaluator settles the Goal after the final work turn, so no turn
      // boundary follows it — only the engine's own metadata announcement.
      const complete = goal({ status: "complete", iteration: 2, lastReason: "Evidence supplied" })
      stream.emit(sessionUpdated({ "claxedo.goal": complete }))

      await settle(() => published.length === 2, "the announced terminal Goal never reached the adapter")
      expect(published[1]).toEqual(complete)
      expect(monitor.isMonitoring(SESSION)).toBe(false)
    } finally {
      stream.end()
      monitor.dispose()
    }
  })

  test("keeps watching while the announced Goal is still active", async () => {
    const stream = feed()
    const published: Array<RuntimeGoalSnapshot | null> = []
    const monitor = monitors({
      request: stream.request,
      readGoal: async () => goal({ iteration: 0 }),
      published,
    })
    try {
      monitor.start(SESSION, DIRECTORY)
      await settle(() => published.length === 1, "the reconnect read never published the active Goal")

      stream.emit(sessionUpdated({ "claxedo.goal": goal({ iteration: 1 }) }))
      await settle(() => published.length === 2, "the announced iteration never reached the adapter")
      expect(published[1]).toEqual(goal({ iteration: 1 }))
      expect(monitor.isMonitoring(SESSION)).toBe(true)
    } finally {
      stream.end()
      monitor.dispose()
    }
  })

  test("a session update that touched no metadata announces nothing", async () => {
    const stream = feed()
    const published: Array<RuntimeGoalSnapshot | null> = []
    const monitor = monitors({
      request: stream.request,
      readGoal: async () => goal(),
      published,
    })
    try {
      monitor.start(SESSION, DIRECTORY)
      await settle(() => published.length === 1, "the reconnect read never published the active Goal")

      // Turn churn republishes the session without touching metadata; only a
      // writer that touched metadata can speak for the Goal.
      stream.emit(sessionUpdated())
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(published).toHaveLength(1)
      expect(monitor.isMonitoring(SESSION)).toBe(true)
    } finally {
      stream.end()
      monitor.dispose()
    }
  })

  test("treats a session whose metadata names no Goal as a Goal that is gone", async () => {
    const stream = feed()
    const published: Array<RuntimeGoalSnapshot | null> = []
    const monitor = monitors({
      request: stream.request,
      readGoal: async () => goal(),
      published,
    })
    try {
      monitor.start(SESSION, DIRECTORY)
      await settle(() => published.length === 1, "the reconnect read never published the active Goal")

      stream.emit(sessionUpdated({}))
      await settle(() => published.length === 2, "the cleared Goal never reached the adapter")
      expect(published[1]).toBeNull()
      expect(monitor.isMonitoring(SESSION)).toBe(false)
    } finally {
      stream.end()
      monitor.dispose()
    }
  })
})

describe("announced Goal snapshots", () => {
  test("an event that is not a session update announces nothing", () => {
    expect(announcedGoalSnapshot({ type: "session.idle", properties: { sessionID: SESSION } } as CompatEvent))
      .toBeUndefined()
  })

  test("a snapshot the engine could not have written is not an announcement", () => {
    expect(announcedGoalSnapshot(sessionUpdated({ "claxedo.goal": { objective: "no status" } }) as CompatEvent))
      .toBeUndefined()
  })
})
