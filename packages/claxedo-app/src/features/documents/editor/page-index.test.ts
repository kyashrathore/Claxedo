import { describe, expect, test } from "bun:test"
import { createDocumentIndexController, repositoryDocumentPath, resolveDocumentProjectScope } from "./page-index"
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

test("stopping a controller prevents an in-flight list from publishing stale state", async () => {
  let resolve!: (documents: DocumentSummary[]) => void
  const pending = new Promise<DocumentSummary[]>((next) => {
    resolve = next
  })
  const states: Array<{ documents: DocumentSummary[] }> = []
  const controller = createDocumentIndexController({
    query: { projectId: "p1" },
    api: { list: () => pending } as DocumentsApi,
    schedule: () => () => undefined,
    onChange: (state) => states.push(state),
    onError: () => undefined,
  })
  const loading = controller.load()
  controller.stop()
  resolve([summary])
  await loading

  expect(states.at(-1)?.documents).toEqual([])
})

test("a watcher callback queued before stop cannot issue a post-abort list or emit state", async () => {
  let callback!: (event: { type: "document.changed" }) => void
  let listCalls = 0
  let emissions = 0
  const controller = createDocumentIndexController({
    query: { projectId: "old" },
    api: {
      list: async () => {
        listCalls++
        return []
      },
      watch: async (_query, next, signal) => {
        callback = next
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }))
      },
    } as DocumentsApi,
    schedule: () => () => undefined,
    onChange: () => {
      emissions++
    },
    onError: () => undefined,
  })
  controller.start()
  await controller.load()
  const beforeStop = { listCalls, emissions }
  controller.stop()
  await controller.load()
  callback({ type: "document.changed" })
  await Promise.resolve()

  expect({ listCalls, emissions }).toEqual(beforeStop)
})

test("document change bursts coalesce into one in-flight list and one trailing refresh", async () => {
  let callback!: (event: { type: "document.changed" }) => void
  let resolveFirst!: (documents: DocumentSummary[]) => void
  const first = new Promise<DocumentSummary[]>((resolve) => {
    resolveFirst = resolve
  })
  let listCalls = 0
  const controller = createDocumentIndexController({
    query: { projectId: "p1" },
    api: {
      list: () => {
        listCalls++
        return listCalls === 1 ? first : Promise.resolve([summary])
      },
      watch: async (_query, next, signal) => {
        callback = next
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }))
      },
    } as DocumentsApi,
    schedule: () => () => undefined,
    onChange: () => undefined,
    onError: () => undefined,
  })
  controller.start()

  callback({ type: "document.changed" })
  callback({ type: "document.changed" })
  callback({ type: "document.changed" })
  expect(listCalls).toBe(1)
  resolveFirst([])
  for (let turn = 0; turn < 8; turn++) await Promise.resolve()

  expect(listCalls).toBe(2)
  expect(controller.snapshot().documents).toEqual([summary])
  controller.stop()
})

describe("repository document path", () => {
  test("accepts contained Markdown paths", () => {
    expect(repositoryDocumentPath(" docs/plans/core.markdown ")).toEqual({ path: "docs/plans/core.markdown" })
  })

  test("rejects empty, absolute, escaping, and non-Markdown paths", () => {
    expect(repositoryDocumentPath("")).toHaveProperty("error")
    expect(repositoryDocumentPath("/tmp/plan.md")).toHaveProperty("error")
    expect(repositoryDocumentPath("../plan.md")).toHaveProperty("error")
    expect(repositoryDocumentPath("docs/plan.txt")).toHaveProperty("error")
  })
})

describe("document project scope", () => {
  const projects = [
    {
      id: "main",
      worktree: "/repo",
      workspaceId: "workspace-main",
      sandboxes: ["/repo/sandbox"],
      workspaces: { sandbox: { directory: "/repo/sandbox", workspaceId: "workspace-sandbox" } },
    },
    {
      id: "hosted",
      worktree: "/local",
      workspaces: { arbitrary: { directory: "/remote", workspaceId: "workspace-remote", kind: "cloud" } },
    },
  ]

  test("resolves main worktrees and sandbox project identity without treating the project id as a workspace id", () => {
    expect(resolveDocumentProjectScope(projects, "/repo")).toEqual({ projectId: "main", workspaceId: "workspace-main" })
    expect(resolveDocumentProjectScope(projects, "/repo/sandbox")).toEqual({
      projectId: "main",
      workspaceId: "workspace-sandbox",
    })
  })

  test("resolves arbitrary workspace map keys and fails closed for an unknown directory", () => {
    expect(resolveDocumentProjectScope(projects, "/remote")).toEqual({
      projectId: "hosted",
      workspaceId: "workspace-remote",
    })
    expect(resolveDocumentProjectScope(projects, "/unknown")).toEqual({})
  })
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
