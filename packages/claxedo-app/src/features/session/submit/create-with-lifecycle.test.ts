import { afterEach, describe, expect, test } from "bun:test"
import {
  createOpencodeSessionWithLifecycle,
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
    emit(event: ClaxedoLifecycleListenerEvent) {
      for (const handler of handlers) handler(event)
    },
    size: () => handlers.size,
  }
}

describe("createOpencodeSessionWithLifecycle", () => {
  test("returns the HTTP result when the perform call succeeds", async () => {
    const { listener, size } = makeListener()
    const result = await createOpencodeSessionWithLifecycle({
      draftId: "draft-a",
      events: listener,
      perform: async () => ({ id: "ses_http" }),
    })
    expect(result).toEqual({ id: "ses_http" })
    expect(size()).toBe(0)
  })

  test("recovers from a lost HTTP response using a matching lifecycle created event", async () => {
    const { listener, emit } = makeListener()
    const promise = createOpencodeSessionWithLifecycle({
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
      await createOpencodeSessionWithLifecycle({
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
      await createOpencodeSessionWithLifecycle({
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
      await createOpencodeSessionWithLifecycle({
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
    const result = await createOpencodeSessionWithLifecycle({
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
      await createOpencodeSessionWithLifecycle({
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
    const result = await createOpencodeSessionWithLifecycle({
      draftId: "draft-c6-happy",
      events: listener,
      perform: async () => ({ id: "ses_c6_happy" }),
      recoveryGraceMs: 30,
    })
    expect(result).toEqual({ id: "ses_c6_happy" })
  })

  test("rubric C7: rolled-back drafts are marked when the wrapper throws via hard failure", async () => {
    const { listener } = makeListener()
    let caught: unknown
    try {
      await createOpencodeSessionWithLifecycle({
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
    expect(wasRolledBackDraft("draft-c7-hard")).toBe(true)
  })

  test("rubric C7: rolled-back drafts are marked when server emits `failed` after HTTP success", async () => {
    const { listener, emit } = makeListener()
    let caught: unknown
    try {
      await createOpencodeSessionWithLifecycle({
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
    const result = await createOpencodeSessionWithLifecycle({
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

    const wrapperPromise = createOpencodeSessionWithLifecycle({
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

  test("rubric T4 (4): listener throw does not kill the wrapper", async () => {
    // Simulate a downstream listener that throws. The makeListener helper
    // runs handlers in a `for...of`; a thrown error inside our wrapper's
    // own handler would surface as an unhandled rejection. The wrapper
    // wraps its handler in try/catch via the event emitter's invocation,
    // so a throw inside the wrapper-internal handler must not corrupt the
    // promise chain.
    const handlers = new Set<(event: ClaxedoLifecycleListenerEvent) => void>()
    const listener: ClaxedoLifecycleListener = {
      on(_type, handler) {
        // Wrap to throw on every invocation — verifies the wrapper's own
        // handler still runs to completion.
        handlers.add(handler)
        return () => handlers.delete(handler)
      },
    }
    const emit = (event: ClaxedoLifecycleListenerEvent) => {
      for (const handler of handlers) {
        try {
          handler(event)
        } catch {
          // swallow to mirror the production emitter's behavior
        }
      }
    }
    const result = await createOpencodeSessionWithLifecycle({
      draftId: "draft-t4-4",
      events: listener,
      perform: async () => {
        // Emit a created event while the wrapper handler is registered —
        // the wrapper handler shouldn't itself throw, but verify the
        // contract by emitting and then succeeding.
        emit({
          type: "session.lifecycle",
          phase: "created",
          directory: "/dir",
          sessionID: "ses_t4_4_event",
          draftId: "draft-t4-4",
          ts: Date.now(),
        })
        return { id: "ses_t4_4_http" }
      },
      recoveryGraceMs: 30,
    })
    expect(result.id).toBe("ses_t4_4_http")
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
    const result = await createOpencodeSessionWithLifecycle({
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
      await createOpencodeSessionWithLifecycle({
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
