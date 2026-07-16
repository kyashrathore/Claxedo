import { describe, expect, test } from "bun:test"
import { createDocumentIndexController } from "./page-index"
import type { DocumentSummary, DocumentsApi } from "../data/documents-api"

const summary = {
  id: "doc-1",
  display_name: "Plan",
  project_id: "p1",
  status: "draft",
  archived_at: null,
} as DocumentSummary

test("metadata-only index lists summaries without opening content", async () => {
  let listCalls = 0
  let openCalls = 0
  const controller = createDocumentIndexController({
    query: { projectId: "p1" },
    api: {
      list: async () => {
        listCalls++
        return [summary]
      },
      open: async () => {
        openCalls++
        throw new Error("must not open")
      },
      watch: async () => new Promise<void>(() => {}),
    } as DocumentsApi,
    schedule: () => () => undefined,
    onChange: () => undefined,
    onError: () => undefined,
  })
  await controller.load()
  expect(controller.snapshot().documents).toEqual([summary])
  expect(listCalls).toBe(1)
  expect(openCalls).toBe(0)
})

describe("EC-B6 index SSE reconnect", () => {
  test("backs off and refetches exactly once after reconnect", async () => {
    const scheduled: Array<() => void> = []
    const watchers: Array<(event: { type: "document.connected" }) => void> = []
    let listCalls = 0
    let watchAttempt = 0
    const api = {
      list: async () => {
        listCalls++
        return [summary]
      },
      watch: async (_query: unknown, onEvent: (event: { type: "document.connected" }) => void) => {
        watchAttempt++
        watchers.push(onEvent)
        if (watchAttempt === 1) throw new Error("stream died")
        return new Promise<void>(() => {})
      },
    } as DocumentsApi
    const controller = createDocumentIndexController({
      query: { projectId: "p1" },
      api,
      schedule: (handler, delay) => {
        expect(delay).toBe(1_000)
        scheduled.push(handler)
        return () => undefined
      },
      onChange: () => undefined,
      onError: () => undefined,
    })
    await controller.load()
    controller.start()
    await Promise.resolve()
    await Promise.resolve()
    expect(scheduled).toHaveLength(1)

    scheduled[0]!()
    await Promise.resolve()
    watchers[1]!({ type: "document.connected" })
    await Promise.resolve()
    expect(listCalls).toBe(2)
    expect(controller.snapshot().connection).toBe("connected")
  })
})
