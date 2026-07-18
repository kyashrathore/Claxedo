import { describe, expect, test } from "bun:test"
import { isThreadNotFound, startTurnWithThreadRecovery } from "./driver"
import { classifyFirstTurnError } from "../../first-turn-error"

const THREAD_UUID = "019f73fb-ef5d-7fd0-9011-124481bc6ef0"

/**
 * A Codex thread lives in the memory of the app-server process that started it. When that
 * subprocess dies (crash, idle kill, host sleep) the driver transparently respawns it, and
 * the fresh process has never heard of the existing threadId — so `turn/start` fails with
 * `thread not found: <uuid>` and, without recovery, every later turn in the session fails
 * permanently. Threads persist to disk, so we resume by id and retry once.
 */
const threadNotFound = () => new Error(`thread not found: ${THREAD_UUID}`)

describe("isThreadNotFound", () => {
  test("matches the app-server's message", () => {
    expect(isThreadNotFound(threadNotFound())).toBe(true)
    expect(isThreadNotFound(new Error("Thread not found: abc"))).toBe(true)
  })

  test("does not match unrelated failures", () => {
    expect(isThreadNotFound(new Error("401 Unauthorized"))).toBe(false)
    expect(isThreadNotFound(new Error("turn interrupted"))).toBe(false)
    expect(isThreadNotFound(undefined)).toBe(false)
  })
})

describe("startTurnWithThreadRecovery", () => {
  test("does not resume when the turn starts cleanly", async () => {
    let resumes = 0
    let starts = 0
    const result = await startTurnWithThreadRecovery({
      startTurn: async () => {
        starts += 1
        return { turn: { id: "turn-1" } }
      },
      resumeThread: async () => {
        resumes += 1
      },
    })

    expect(result).toEqual({ turn: { id: "turn-1" } })
    expect(starts).toBe(1)
    expect(resumes).toBe(0)
  })

  test("resumes the thread and retries once when the process lost the thread", async () => {
    const calls: string[] = []
    let starts = 0
    const result = await startTurnWithThreadRecovery({
      startTurn: async () => {
        starts += 1
        calls.push(`start:${starts}`)
        if (starts === 1) throw threadNotFound()
        return { turn: { id: "turn-after-resume" } }
      },
      resumeThread: async () => {
        calls.push("resume")
      },
    })

    expect(result).toEqual({ turn: { id: "turn-after-resume" } })
    // Order matters: the resume must happen between the two turn attempts.
    expect(calls).toEqual(["start:1", "resume", "start:2"])
  })

  test("never retries a failure that is not a missing thread", async () => {
    let resumes = 0
    let starts = 0
    const attempt = startTurnWithThreadRecovery({
      startTurn: async () => {
        starts += 1
        throw new Error("401 Unauthorized")
      },
      resumeThread: async () => {
        resumes += 1
      },
    })

    await expect(attempt).rejects.toThrow("401 Unauthorized")
    // Masking a real failure behind a resume would be worse than the original bug.
    expect(starts).toBe(1)
    expect(resumes).toBe(0)
  })

  test("surfaces a resume failure instead of hiding it", async () => {
    const attempt = startTurnWithThreadRecovery({
      startTurn: async () => {
        throw threadNotFound()
      },
      resumeThread: async () => {
        throw new Error("thread is not resumable")
      },
    })

    await expect(attempt).rejects.toThrow("thread is not resumable")
  })

  test("recovers on the second resume cycle when the first retry still misses", async () => {
    const calls: string[] = []
    let starts = 0
    const result = await startTurnWithThreadRecovery({
      startTurn: async () => {
        starts += 1
        calls.push(`start:${starts}`)
        // Fail the first two attempts, succeed on the third (after two resumes).
        if (starts <= 2) throw threadNotFound()
        return { turn: { id: "turn-after-second-resume" } }
      },
      resumeThread: async () => {
        calls.push("resume")
      },
    })

    expect(result).toEqual({ turn: { id: "turn-after-second-resume" } })
    expect(calls).toEqual(["start:1", "resume", "start:2", "resume", "start:3"])
  })

  test("goes terminal with a classified session error once recovery is exhausted", async () => {
    let starts = 0
    let resumes = 0
    let caught: Error | undefined
    try {
      await startTurnWithThreadRecovery({
        startTurn: async () => {
          starts += 1
          throw threadNotFound()
        },
        resumeThread: async () => {
          resumes += 1
        },
      })
    } catch (err) {
      caught = err as Error
    }

    // Bounded: one initial attempt + two resume+retry cycles, then it stops.
    expect(starts).toBe(3)
    expect(resumes).toBe(2)
    expect(caught).toBeInstanceOf(Error)
    // The terminal error classifies as `session` so it routes to session recovery…
    expect(classifyFirstTurnError(caught!)).toBe("session")
    // …the raw protocol string + uuid survive for the raw-detail disclosure…
    expect(caught!.message).toContain(THREAD_UUID)
    expect(caught!.message).toContain("thread not found")
    // …but the uuid is never the headline: the classified copy leads the message,
    // and the class (not the uuid) is what drives what the user sees.
    expect(caught!.message).not.toMatch(new RegExp(`^thread not found: ${THREAD_UUID}`))
    expect(caught!.message.startsWith("The agent process no longer has this conversation")).toBe(true)
  })
})
