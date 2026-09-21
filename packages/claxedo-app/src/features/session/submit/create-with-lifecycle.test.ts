import { afterEach, describe, expect, spyOn, test } from "bun:test"
import {
  createSessionWithLifecycle,
  type ClaxedoLifecycleListener,
  type ClaxedoLifecycleListenerEvent,
} from "./create-with-lifecycle"
import { _resetRolledBackDraftsForTest, wasRolledBackDraft } from "./rolled-back-drafts"

afterEach(() => {
  _resetRolledBackDraftsForTest()
})

function makeListener() {
  const handlers = new Set<(event: ClaxedoLifecycleListenerEvent) => void>()
  const listener: ClaxedoLifecycleListener = {
    on(_type, handler) {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
  }
  return {
    listener,
    emit: (event: ClaxedoLifecycleListenerEvent) => {
      for (const handler of handlers) handler(event)
    },
    size: () => handlers.size,
  }
}

describe("createSessionWithLifecycle", () => {
  test("returns the HTTP result when the perform call succeeds", async () => {
    const { listener, size } = makeListener()
    const result = await createSessionWithLifecycle({
      draftId: "draft-a",
      events: listener,
      perform: async () => ({ id: "ses_http" }),
      recoveryGraceMs: 0,
    })
    expect(result).toEqual({ id: "ses_http" })
    expect(size()).toBe(0)
  })

  test.each(["created", "failed"] as const)("releases the grace timer when a matching %s event settles the lost-response wait", async (phase) => {
    const { listener, emit, size } = makeListener()
    const nativeSetTimeout = globalThis.setTimeout
    const timers: Array<ReturnType<typeof setTimeout>> = []
    const schedule = spyOn(globalThis, "setTimeout").mockImplementation(((handler, delay, ...args) => {
      const token = nativeSetTimeout(handler, delay, ...args)
      timers.push(token)
      return token
    }) as typeof setTimeout)
    const cancel = spyOn(globalThis, "clearTimeout")
    try {
      const pending = createSessionWithLifecycle({
        draftId: "draft-timer", events: listener,
        perform: async () => { throw new Error("lost response") },
      })
      await Promise.resolve()
      expect(timers).toHaveLength(1)
      const deadline = timers[0]
      emit({ type: "session.lifecycle", phase, draftId: "draft-timer", sessionID: "ses_timer", directory: "/repo", ts: 1, message: "initialization failed" })
      if (phase === "created") await expect(pending).resolves.toEqual({ id: "ses_timer" })
      else await expect(pending).rejects.toThrow("initialization failed")
      expect(cancel).toHaveBeenCalledWith(deadline)
      expect(size()).toBe(0)
    } finally {
      for (const timer of timers) clearTimeout(timer)
      schedule.mockRestore()
      cancel.mockRestore()
    }
  })

  test("recovers from a lost HTTP response using a matching lifecycle created event", async () => {
    const { listener, emit } = makeListener()
    const promise = createSessionWithLifecycle({
      draftId: "draft-b",
      events: listener,
      perform: async () => {
        queueMicrotask(() => {
          emit({
            type: "session.lifecycle",
            phase: "created",
            directory: "/dir",
            sessionID: "ses_event",
            draftId: "draft-b",
            ts: Date.now(),
          })
        })
        throw new Error("network blip")
      },
    })
    const result = await promise
    expect(result).toEqual({ id: "ses_event" })
  })

  test("propagates the original error when no lifecycle event arrives within the grace window", async () => {
    const { listener } = makeListener()
    let caught: unknown
    try {
      await createSessionWithLifecycle({
        draftId: "draft-c",
        events: listener,
        perform: async () => {
          throw new Error("hard failure")
        },
        recoveryGraceMs: 5,
      })
    } catch (err) {
      caught = err
    }
    expect((caught as Error).message).toBe("hard failure")
  })

  test("uses the lifecycle failed message when no created event recovers", async () => {
    const { listener, emit } = makeListener()
    let caught: unknown
    try {
      await createSessionWithLifecycle({
        draftId: "draft-d",
        events: listener,
        perform: async () => {
          queueMicrotask(() => {
            emit({
              type: "session.lifecycle",
              phase: "failed",
              directory: "/dir",
              draftId: "draft-d",
              message: "runner unavailable",
              ts: Date.now(),
            })
          })
          throw new Error("hard failure")
        },
        recoveryGraceMs: 30,
      })
    } catch (err) {
      caught = err
    }
    expect((caught as Error).message).toBe("runner unavailable")
  })

  test("ignores lifecycle events for unrelated drafts", async () => {
    const { listener, emit } = makeListener()
    let caught: unknown
    try {
      await createSessionWithLifecycle({
        draftId: "draft-e",
        events: listener,
        perform: async () => {
          queueMicrotask(() => {
            emit({
              type: "session.lifecycle",
              phase: "created",
              directory: "/dir",
              sessionID: "ses_other",
              draftId: "different-draft",
              ts: Date.now(),
            })
          })
          throw new Error("hard failure")
        },
        recoveryGraceMs: 30,
      })
    } catch (err) {
      caught = err
    }
    expect((caught as Error).message).toBe("hard failure")
  })

  test("bypasses subscription when no draftId is provided", async () => {
    const { listener, size } = makeListener()
    const result = await createSessionWithLifecycle({
      events: listener,
      perform: async () => ({ id: "ses_bare" }),
    })
    expect(result).toEqual({ id: "ses_bare" })
    expect(size()).toBe(0)
  })

  test("rubric C6: HTTP success + lifecycle failed within grace → server wins", async () => {
    const { listener, emit } = makeListener()
    let caught: unknown
    try {
      await createSessionWithLifecycle({
        draftId: "draft-c6",
        events: listener,
        perform: async () => {
          // The HTTP returns success; immediately afterwards the backend
          // emits a failed event for the same draftId. Pre-fix the wrapper
          // would have returned `{ id: "ses_c6_http" }` and the UI would
          // have shown a phantom session. Post-fix the wrapper rejects
          // with the backend-emitted reason.
          queueMicrotask(() => {
            emit({
              type: "session.lifecycle",
              phase: "failed",
              directory: "/dir",
              draftId: "draft-c6",
              message: "runner crashed during init",
              ts: Date.now(),
            })
          })
          return { id: "ses_c6_http" }
        },
        recoveryGraceMs: 30,
      })
    } catch (err) {
      caught = err
    }
    expect((caught as Error).message).toBe("runner crashed during init")
  })

  test("rubric C6: HTTP success + no lifecycle failed within grace → HTTP result", async () => {
    const { listener } = makeListener()
    const result = await createSessionWithLifecycle({
      draftId: "draft-c6-happy",
      events: listener,
      perform: async () => ({ id: "ses_c6_happy" }),
      recoveryGraceMs: 30,
    })
    expect(result).toEqual({ id: "ses_c6_happy" })
  })

  test("a transport failure without an authoritative failed event leaves late creation admissible", async () => {
    const { listener } = makeListener()
    let caught: unknown
    try {
      await createSessionWithLifecycle({
        draftId: "draft-c7-hard",
        events: listener,
        perform: async () => {
          throw new Error("hard failure")
        },
        recoveryGraceMs: 5,
      })
    } catch (err) {
      caught = err
    }
    expect((caught as Error).message).toBe("hard failure")
    expect(wasRolledBackDraft("draft-c7-hard")).toBe(false)
  })

  test("rubric C7: rolled-back drafts are marked when server emits `failed` after HTTP success", async () => {
    const { listener, emit } = makeListener()
    let caught: unknown
    try {
      await createSessionWithLifecycle({
        draftId: "draft-c7-server",
        events: listener,
        perform: async () => {
          queueMicrotask(() => {
            emit({
              type: "session.lifecycle",
              phase: "failed",
              directory: "/dir",
              draftId: "draft-c7-server",
              message: "runner crashed",
              ts: Date.now(),
            })
          })
          return { id: "ses_c7_phantom" }
        },
        recoveryGraceMs: 30,
      })
    } catch (err) {
      caught = err
    }
    expect((caught as Error).message).toBe("runner crashed")
    expect(wasRolledBackDraft("draft-c7-server")).toBe(true)
  })

  test("rubric C7: a successful HTTP create does NOT mark the draft as rolled back", async () => {
    const { listener } = makeListener()
    const result = await createSessionWithLifecycle({
      draftId: "draft-c7-ok",
      events: listener,
      perform: async () => ({ id: "ses_c7_ok" }),
      recoveryGraceMs: 30,
    })
    expect(result).toEqual({ id: "ses_c7_ok" })
    expect(wasRolledBackDraft("draft-c7-ok")).toBe(false)
  })

  // Rubric T4: explicit coverage for every subscribe-then-fetch race the
  // wrapper has to handle. These pin behavior that would otherwise be
  // "undefined" and let future refactors detect a regression immediately.

  test("rubric T4 (1): event-BEFORE-HTTP — the reload-during-provisioning case", async () => {
    // Lifecycle `created` arrives BEFORE the HTTP perform call resolves.
    // The wrapper should still return the HTTP result (it's the source of
    // truth when both succeed), but the recovered path is primed and would
    // pick up the event if the HTTP call eventually failed.
    const { listener, emit } = makeListener()
    let httpResolve: ((value: { id: string }) => void) | undefined
    const httpPromise = new Promise<{ id: string }>((r) => {
      httpResolve = r
    })

    const wrapperPromise = createSessionWithLifecycle({
      draftId: "draft-t4-1",
      events: listener,
      perform: async () => httpPromise,
      recoveryGraceMs: 30,
    })

    // Emit the event before the HTTP promise resolves.
    emit({
      type: "session.lifecycle",
      phase: "created",
      directory: "/dir",
      sessionID: "ses_t4_1_event",
      draftId: "draft-t4-1",
      ts: Date.now(),
    })
    // Now resolve HTTP. HTTP source-of-truth wins.
    httpResolve!({ id: "ses_t4_1_http" })
    const result = await wrapperPromise
    expect(result).toEqual({ id: "ses_t4_1_http" })
  })

  test.each(["success", "failure"] as const)("a terminal lifecycle failure wins after created and HTTP %s", async (http) => {
    const { listener, emit, size } = makeListener()
    const draftId = `draft-created-then-failed-${http}`
    const result = createSessionWithLifecycle({
      draftId,
      events: listener,
      perform: async () => {
        emit({ type: "session.lifecycle", phase: "created", directory: "/dir", sessionID: "ses_partial", draftId, ts: 1 })
        emit({ type: "session.lifecycle", phase: "failed", directory: "/dir", draftId, message: "initialization failed", ts: 2 })
        if (http === "failure") throw new Error("response lost")
        return { id: "ses_partial" }
      },
      recoveryGraceMs: 5,
    })
    await expect(result).rejects.toThrow("initialization failed")
    expect(wasRolledBackDraft(draftId)).toBe(true)
    expect(size()).toBe(0)
  })

  test("rubric T4 (5): external unsubscribe mid-flight does not break recovery", async () => {
    // If the events provider tears down (page unload, provider cleanup),
    // the wrapper's unsubscribe is called externally OR the emit becomes a
    // no-op. The wrapper should still return the HTTP result.
    let handlerRef: ((event: ClaxedoLifecycleListenerEvent) => void) | undefined
    const externalUnsubs: Array<() => void> = []
    const listener: ClaxedoLifecycleListener = {
      on(_type, handler) {
        handlerRef = handler
        const unsub = () => {
          handlerRef = undefined
        }
        externalUnsubs.push(unsub)
        return unsub
      },
    }
    const result = await createSessionWithLifecycle({
      draftId: "draft-t4-5",
      events: listener,
      perform: async () => {
        // External force-unsubscribe right after listener registered.
        externalUnsubs[0]?.()
        return { id: "ses_t4_5_http" }
      },
      recoveryGraceMs: 30,
    })
    expect(result.id).toBe("ses_t4_5_http")
    // No leaked handler reference.
    expect(handlerRef).toBeUndefined()
  })

  test("rubric T4 (6): `created` event with empty sessionID is ignored (does not recover)", async () => {
    // A malformed `created` envelope without sessionID must not pretend
    // to recover. The wrapper should still throw the original HTTP error.
    const { listener, emit } = makeListener()
    let caught: unknown
    try {
      await createSessionWithLifecycle({
        draftId: "draft-t4-6",
        events: listener,
        perform: async () => {
          queueMicrotask(() => {
            emit({
              type: "session.lifecycle",
              phase: "created",
              directory: "/dir",
              sessionID: "", // empty — should be ignored
              draftId: "draft-t4-6",
              ts: Date.now(),
            })
          })
          throw new Error("http failed")
        },
        recoveryGraceMs: 30,
      })
    } catch (err) {
      caught = err
    }
    expect((caught as Error).message).toBe("http failed")
  })
})


test("starting owner reaches only its draft while creation HTTP remains pending", async () => {
  const { listener, emit } = makeListener()
  const owners: ClaxedoLifecycleListenerEvent[] = []
  let resolve!: (value: { id: string }) => void
  let settled = false
  const pending = createSessionWithLifecycle({ draftId: "draft-a", events: listener, onLifecycle: (event) => owners.push(event), perform: () => new Promise((done) => { resolve = done }), recoveryGraceMs: 0 }).then((result) => { settled = true; return result })
  const event: ClaxedoLifecycleListenerEvent = { type: "session.lifecycle", phase: "creating", directory: "/repo", draftId: "draft-a", ts: 1, start: { sessionId: "reserved", workspaceId: "workspace", directory: "/repo", connectionId: "agent", operationId: "op" } }
  emit({ ...event, draftId: "draft-b" })
  emit(event)
  await Promise.resolve()
  expect(owners).toEqual([event])
  expect(settled).toBe(false)
  resolve({ id: "reserved" })
  expect(await pending).toEqual({ id: "reserved" })
})
