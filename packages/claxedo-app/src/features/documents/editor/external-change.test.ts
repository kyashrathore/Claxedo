import { describe, expect, test } from "bun:test"
import { createDocumentExternalChangeController } from "./external-change"

function harness() {
  const applied: string[] = []
  const errors: unknown[] = []
  const unavailable: unknown[] = []
  const scheduled: Array<() => void> = []
  const focus = new Set<() => void>()
  let event: ((value: { type: string; document_id?: string }) => void) | undefined
  let resolveWatch: (() => void) | undefined
  let reads = 0
  const controller = createDocumentExternalChangeController({
    documentId: "document-1",
    projectId: "project-1",
    watch: (_query, onEvent) => {
      event = onEvent
      return new Promise<void>((resolve) => {
        resolveWatch = resolve
      })
    },
    read: async () => ({ displayName: "Plan", markdown: `version ${++reads}`, version: `v${reads}` }),
    apply: (current) => applied.push(current.markdown),
    onUnavailable: (error) => unavailable.push(error),
    onError: (error) => errors.push(error),
    schedule: (run) => {
      scheduled.push(run)
      return () => {
        const index = scheduled.indexOf(run)
        if (index >= 0) scheduled.splice(index, 1)
      }
    },
    subscribeFocus: (refresh) => {
      focus.add(refresh)
      return () => focus.delete(refresh)
    },
  })
  return {
    controller,
    applied,
    errors,
    unavailable,
    scheduled,
    focus,
    event: (value: { type: string; document_id?: string }) => event?.(value),
    closeStream: () => resolveWatch?.(),
    reads: () => reads,
    async settle() {
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

describe("document external change controller", () => {
  test("stop invalidates an in-flight reread before success or error callbacks", async () => {
    let resolveRead!: (value: { displayName: string; markdown: string; version: string }) => void
    const pending = new Promise<{ displayName: string; markdown: string; version: string }>((resolve) => {
      resolveRead = resolve
    })
    const applied: string[] = []
    const errors: unknown[] = []
    const controller = createDocumentExternalChangeController({
      documentId: "document-1",
      projectId: "project-1",
      watch: async () => await new Promise<void>(() => {}),
      read: () => pending,
      apply: (current) => applied.push(current.markdown),
      onUnavailable: (error) => errors.push(error),
      onError: (error) => errors.push(error),
      schedule: () => () => {},
      subscribeFocus: () => () => {},
    })

    controller.start()
    controller.stop()
    resolveRead({ displayName: "Stale", markdown: "stale", version: "v1" })
    await Promise.resolve()
    await Promise.resolve()

    expect(applied).toEqual([])
    expect(errors).toEqual([])
  })

  test("stop ignores an in-flight reread rejection", async () => {
    let rejectRead!: (error: unknown) => void
    const pending = new Promise<{ displayName: string; markdown: string; version: string }>((_, reject) => {
      rejectRead = reject
    })
    const errors: unknown[] = []
    const controller = createDocumentExternalChangeController({
      documentId: "document-1",
      projectId: "project-1",
      watch: async () => await new Promise<void>(() => {}),
      read: () => pending,
      apply: () => {},
      onUnavailable: (error) => errors.push(error),
      onError: (error) => errors.push(error),
      schedule: () => () => {},
      subscribeFocus: () => () => {},
    })

    controller.start()
    controller.stop()
    rejectRead(new Error("stale"))
    await Promise.resolve()
    await Promise.resolve()

    expect(errors).toEqual([])
  })

  test("restart ignores the old run and applies only the new run reread", async () => {
    let resolveOld!: (value: { displayName: string; markdown: string; version: string }) => void
    const old = new Promise<{ displayName: string; markdown: string; version: string }>((resolve) => {
      resolveOld = resolve
    })
    let reads = 0
    const applied: string[] = []
    const controller = createDocumentExternalChangeController({
      documentId: "document-1",
      projectId: "project-1",
      watch: async () => await new Promise<void>(() => {}),
      read: () => {
        reads++
        return reads === 1 ? old : Promise.resolve({ displayName: "Current", markdown: "current", version: "v2" })
      },
      apply: (current) => applied.push(current.markdown),
      onUnavailable: () => {},
      onError: () => {},
      schedule: () => () => {},
      subscribeFocus: () => () => {},
    })

    controller.start()
    controller.stop()
    controller.start()
    resolveOld({ displayName: "Stale", markdown: "stale", version: "v1" })
    for (let turn = 0; turn < 6; turn++) await Promise.resolve()

    expect(reads).toBe(2)
    expect(applied).toEqual(["current"])
    controller.stop()
  })

  test("refreshes immediately, on a matching SSE event, and on focus", async () => {
    const value = harness()
    value.controller.start()
    await value.settle()
    expect(value.applied).toEqual(["version 1"])

    value.event({ type: "document.connected" })
    await value.settle()
    expect(value.applied.at(-1)).toBe("version 2")

    value.event({ type: "document.changed", document_id: "another" })
    await value.settle()
    expect(value.reads()).toBe(2)
    value.event({ type: "document.changed", document_id: "document-1" })
    await value.settle()
    expect(value.applied.at(-1)).toBe("version 3")
    value.focus.forEach((refresh) => refresh())
    await value.settle()
    expect(value.applied.at(-1)).toBe("version 4")
    value.controller.stop()
  })

  test("coalesces events arriving during a reread into one final reread", async () => {
    let release: (() => void) | undefined
    let appliedTwice: (() => void) | undefined
    const twice = new Promise<void>((resolve) => {
      appliedTwice = resolve
    })
    let reads = 0
    const applied: string[] = []
    const controller = createDocumentExternalChangeController({
      documentId: "document-1",
      projectId: "project-1",
      watch: async () => await new Promise<void>(() => {}),
      read: async () => {
        reads++
        if (reads === 1)
          await new Promise<void>((resolve) => {
            release = resolve
          })
        return { displayName: "Plan", markdown: `${reads}`, version: `${reads}` }
      },
      apply: (current) => {
        applied.push(current.markdown)
        if (applied.length === 2) appliedTwice?.()
      },
      onUnavailable: () => {},
      onError: () => {},
      schedule: () => () => {},
      subscribeFocus: () => () => {},
    })
    controller.start()
    controller.refresh()
    controller.refresh()
    release?.()
    await twice
    expect(reads).toBe(2)
    expect(applied).toEqual(["1", "2"])
    controller.stop()
  })

  test("reconnects with backoff and refetches when the SSE stream reconnects", async () => {
    const value = harness()
    value.controller.start()
    await value.settle()
    value.closeStream()
    await value.settle()
    expect(value.scheduled).toHaveLength(1)
    value.scheduled.shift()?.()
    await value.settle()
    value.event({ type: "document.connected" })
    await value.settle()
    expect(value.applied.at(-1)).toBe("version 2")
    value.controller.stop()
  })

  test("routes typed unavailability separately and stops every listener", async () => {
    const unavailable = new Error("missing")
    const value = harness()
    const controller = createDocumentExternalChangeController({
      documentId: "document-1",
      projectId: "project-1",
      watch: async () => await new Promise<void>(() => {}),
      read: async () => {
        throw unavailable
      },
      apply: () => {},
      isUnavailable: (error) => error === unavailable,
      onUnavailable: (error) => value.unavailable.push(error),
      onError: (error) => value.errors.push(error),
      schedule: () => () => {},
      subscribeFocus: (refresh) => {
        value.focus.add(refresh)
        return () => value.focus.delete(refresh)
      },
    })
    controller.start()
    await value.settle()
    expect(value.unavailable).toEqual([unavailable])
    expect(value.errors).toEqual([])
    controller.stop()
    expect(value.focus.size).toBe(0)
  })
})
