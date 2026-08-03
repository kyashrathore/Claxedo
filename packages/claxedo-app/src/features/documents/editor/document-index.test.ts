import { describe, expect, test } from "bun:test"
import { createDocumentIndexController, documentProjectIdentity, resolveDocumentProjectScope } from "./document-index"
import { DocumentApiError, type DocumentSummary, type DocumentsApi } from "../data/documents-api"
import type { DocumentChangedEvent } from "../data/document-changed-event"

// The central-bus doorbell envelope: camelCase and identity-only. This is the
// sole surviving client consumer of `document.changed`; the legacy snake_case
// `/documents/events` SSE and the editor's external-change controller are gone.
const changed = (projectId: string, documentId = "doc-1"): DocumentChangedEvent => ({
  type: "document.changed",
  documentId,
  orgId: "org-1",
  projectId,
  ts: 1,
})

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
    queries: [{ projectId: "p1" }],
    api: {
      list: async () => {
        listCalls++
        return [summary]
      },
      open: async () => {
        openCalls++
        throw new Error("must not open")
      },
    } as DocumentsApi,
    onChange: () => undefined,
    onError: () => undefined,
  })
  await controller.load()
  expect(controller.snapshot().groups).toEqual([{ projectId: "p1", documents: [summary] }])
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
    queries: [{ projectId: "p1" }],
    api: { list: () => pending } as DocumentsApi,
    onChange: (state) => states.push(state),
    onError: () => undefined,
  })
  const loading = controller.load()
  controller.stop()
  resolve([summary])
  await loading

  expect(states.at(-1)?.groups).toEqual([])
})

// The doorbell is a shared stream the controller does not own, so a nudge can
// still be delivered after stop() if it was already queued. It must be inert.
test("a doorbell nudge queued before stop cannot issue a post-stop list or emit state", async () => {
  let callback!: (event: DocumentChangedEvent) => void
  let unsubscribed = 0
  let listCalls = 0
  let emissions = 0
  const controller = createDocumentIndexController({
    queries: [{ projectId: "old" }],
    api: {
      list: async () => {
        listCalls++
        return []
      },
    } as DocumentsApi,
    subscribe: (next) => {
      callback = next
      return () => {
        unsubscribed++
      }
    },
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
  callback(changed("old"))
  await Promise.resolve()

  expect({ listCalls, emissions }).toEqual(beforeStop)
  expect(unsubscribed).toBe(1)
})

test("document change bursts coalesce into one in-flight list and one trailing refresh", async () => {
  let callback!: (event: DocumentChangedEvent) => void
  let resolveFirst!: (documents: DocumentSummary[]) => void
  const first = new Promise<DocumentSummary[]>((resolve) => {
    resolveFirst = resolve
  })
  let listCalls = 0
  const controller = createDocumentIndexController({
    queries: [{ projectId: "p1" }],
    api: {
      list: () => {
        listCalls++
        return listCalls === 1 ? first : Promise.resolve([summary])
      },
    } as DocumentsApi,
    subscribe: (next) => {
      callback = next
      return () => undefined
    },
    onChange: () => undefined,
    onError: () => undefined,
  })
  controller.start()

  callback(changed("p1"))
  callback(changed("p1"))
  callback(changed("p1"))
  expect(listCalls).toBe(1)
  resolveFirst([])
  for (let turn = 0; turn < 8; turn++) await Promise.resolve()

  expect(listCalls).toBe(2)
  expect(controller.snapshot().groups).toEqual([{ projectId: "p1", documents: [summary] }])
  controller.stop()
})

// The index spans every project now, and the server has no cross-project list —
// every list call is authorized against exactly one project — so the controller
// fans out and merges. These pin the two properties that makes safe: one bad
// project cannot blank the page, and its absence is never silent.
describe("multi-project fan-out", () => {
  const other = { ...summary, id: "doc-2", project_id: "p2", display_name: "Notes" } as DocumentSummary

  test("merges every project's documents into one list", async () => {
    const controller = createDocumentIndexController({
      queries: [{ projectId: "p1" }, { projectId: "p2" }],
      api: {
        list: async (query: { projectId?: string }) => (query.projectId === "p1" ? [summary] : [other]),
      } as DocumentsApi,
      onChange: () => undefined,
      onError: () => undefined,
    })
    await controller.load()

    // Grouped under the project each list was ASKED for. `summary.project_id`
    // is "p1" here by coincidence of the fixture; locally the server answers
    // with its own `project_<uuid>`, which is exactly why the group cannot be
    // keyed on the echoed id.
    expect(controller.snapshot().groups).toEqual([
      { projectId: "p1", documents: [summary] },
      { projectId: "p2", documents: [other] },
    ])
    expect(controller.snapshot().unavailable).toEqual([])
    expect(controller.snapshot().error).toBeUndefined()
  })

  // Regression: a local workspace's documents come back stamped with the
  // server's own project id (`resolveLocalProjectId` mints `project_<uuid>` per
  // canonical directory). Grouping on that id found no project in the inventory
  // and printed a raw uuid as the heading.
  test("groups by the requested project even when the server echoes a different id", async () => {
    const controller = createDocumentIndexController({
      queries: [{ projectId: "p1", directory: "/code/alpha" }],
      api: {
        list: async () => [{ ...summary, project_id: "project_4c4e6dc5a1124db98c55e173a8caa817" } as DocumentSummary],
      } as DocumentsApi,
      onChange: () => undefined,
      onError: () => undefined,
    })
    await controller.load()

    expect(controller.snapshot().groups[0]?.projectId).toBe("p1")
  })

  test("keeps the readable projects and names the one that failed", async () => {
    const errors: unknown[] = []
    const controller = createDocumentIndexController({
      queries: [{ projectId: "p1" }, { projectId: "p2" }],
      api: {
        list: async (query: { projectId?: string }) => {
          if (query.projectId === "p2") throw new Error("forbidden")
          return [summary]
        },
      } as DocumentsApi,
      onChange: () => undefined,
      onError: (error) => errors.push(error),
    })
    await controller.load()

    // p1's documents survive p2's 403, and no error banner claims the index is broken…
    expect(controller.snapshot().groups).toEqual([{ projectId: "p1", documents: [summary] }])
    expect(controller.snapshot().error).toBeUndefined()
    // …but the shortfall is reported rather than passed off as a complete list.
    expect(controller.snapshot().unavailable).toEqual(["p2"])
    expect(errors).toHaveLength(1)
  })

  test("surfaces an error only when every project fails", async () => {
    const controller = createDocumentIndexController({
      queries: [{ projectId: "p1" }, { projectId: "p2" }],
      api: {
        list: async () => {
          throw new Error("offline")
        },
      } as DocumentsApi,
      onChange: () => undefined,
      onError: () => undefined,
    })
    await controller.load()

    expect(controller.snapshot().error).toBe("offline")
    expect(controller.snapshot().unavailable).toEqual(["p1", "p2"])
  })

  // Locally the doorbell reports the server's own `project_<uuid>`, which never
  // equals the app-inventory id we asked for. Matching only against the query
  // dropped every local nudge and silently froze the index — so the mapping is
  // learned from the documents that came back.
  test("refreshes on a doorbell carrying the server's id for a project we list", async () => {
    const local = "project_4c4e6dc5a1124db98c55e173a8caa817"
    let callback!: (event: DocumentChangedEvent) => void
    let listCalls = 0
    const controller = createDocumentIndexController({
      queries: [{ projectId: "p1", directory: "/code/alpha" }],
      api: {
        list: async () => {
          listCalls++
          return [{ ...summary, project_id: local } as DocumentSummary]
        },
      } as DocumentsApi,
      subscribe: (next) => {
        callback = next
        return () => undefined
      },
      onChange: () => undefined,
      onError: () => undefined,
    })
    await controller.load()
    controller.start()
    expect(listCalls).toBe(1)

    callback(changed(local))
    for (let turn = 0; turn < 8; turn++) await Promise.resolve()

    expect(listCalls).toBe(2)
    controller.stop()
  })

  // A project we asked for that has no documents yet has no learned id, so an
  // unfamiliar nudge might be its first document arriving. Fail toward freshness.
  test("refreshes on an unfamiliar nudge while a requested project is still unmapped", async () => {
    let callback!: (event: DocumentChangedEvent) => void
    let listCalls = 0
    const controller = createDocumentIndexController({
      queries: [{ projectId: "p1", directory: "/code/alpha" }],
      api: {
        list: async () => {
          listCalls++
          return []
        },
      } as DocumentsApi,
      subscribe: (next) => {
        callback = next
        return () => undefined
      },
      onChange: () => undefined,
      onError: () => undefined,
    })
    await controller.load()
    controller.start()

    callback(changed("project_4c4e6dc5a1124db98c55e173a8caa817"))
    for (let turn = 0; turn < 8; turn++) await Promise.resolve()

    expect(listCalls).toBe(2)
    controller.stop()
  })

  // A 404 is `authorizeProject` fail-closed: the project is gone or not ours,
  // and no doorbell or reconnect changes that — only a new inventory (which
  // rebuilds the controller). Staging demonstrated the alternative: leaked
  // smoke workspaces made every revalidation edge re-fire one guaranteed 404
  // per corpse, forever.
  test("quarantines a project after a 404 — later refreshes stop asking for it", async () => {
    const listed: (string | undefined)[] = []
    const controller = createDocumentIndexController({
      queries: [{ projectId: "p1" }, { projectId: "p-dead" }],
      api: {
        list: async (query: { projectId?: string }) => {
          listed.push(query.projectId)
          if (query.projectId === "p-dead") throw new DocumentApiError("document_not_found", 404, "not found")
          return [summary]
        },
      } as DocumentsApi,
      onChange: () => undefined,
      onError: () => undefined,
    })
    await controller.load()
    expect(controller.snapshot().unavailable).toEqual(["p-dead"])

    await controller.load(false)
    await controller.load(false)

    // p-dead was asked exactly once; p1 keeps refreshing. The quarantined
    // project stays visibly unavailable rather than silently vanishing.
    expect(listed.filter((id) => id === "p-dead")).toHaveLength(1)
    expect(listed.filter((id) => id === "p1")).toHaveLength(3)
    expect(controller.snapshot().unavailable).toEqual(["p-dead"])
    expect(controller.snapshot().error).toBeUndefined()
  })

  test("a transient failure is NOT quarantined — the next refresh retries it", async () => {
    let attempts = 0
    const controller = createDocumentIndexController({
      queries: [{ projectId: "p1" }],
      api: {
        list: async () => {
          attempts++
          if (attempts === 1) throw new DocumentApiError("document_request_failed", 503, "upstream down")
          return [summary]
        },
      } as DocumentsApi,
      onChange: () => undefined,
      onError: () => undefined,
    })
    await controller.load()
    expect(controller.snapshot().unavailable).toEqual(["p1"])

    await controller.load(false)
    expect(attempts).toBe(2)
    expect(controller.snapshot().groups).toEqual([{ projectId: "p1", documents: [summary] }])
    expect(controller.snapshot().unavailable).toEqual([])
  })

  test("all live projects 404ing still raises the error banner once", async () => {
    const controller = createDocumentIndexController({
      queries: [{ projectId: "p1" }],
      api: {
        list: async () => {
          throw new DocumentApiError("document_not_found", 404, "not found")
        },
      } as DocumentsApi,
      onChange: () => undefined,
      onError: () => undefined,
    })
    await controller.load()
    expect(controller.snapshot().error).toBe("not found")
    expect(controller.snapshot().unavailable).toEqual(["p1"])
  })
})

describe("project identity", () => {
  const projects = [{ id: "p1", worktree: "/Users/me/code/formlink", workspaceId: "w1" }]

  test("names a project by its worktree basename and keeps the path as detail", () => {
    expect(documentProjectIdentity(projects, "p1")).toEqual({
      id: "p1",
      label: "formlink",
      detail: "/Users/me/code/formlink",
    })
  })

  test("renders an unknown project as its id rather than inventing a name", () => {
    expect(documentProjectIdentity(projects, "ghost")).toEqual({ id: "ghost", label: "ghost" })
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

// EC-B6, restated for the doorbell. The controller
// no longer owns a socket, so it no longer backs off or reconnects — the central
// stream does. What survives is the guarantee that mattered: after the stream
// drops and recovers, the index revalidates EXACTLY once, covering every nudge
// missed while it was down (R4 — never silently stale).
describe("EC-B6 index revalidation on central-stream reconnect", () => {
  test("refetches exactly once on the reconnect edge, not on every connected report", async () => {
    let listCalls = 0
    let connectedHandler!: (connected: boolean) => void
    const controller = createDocumentIndexController({
      queries: [{ projectId: "p1" }],
      api: {
        list: async () => {
          listCalls++
          return [summary]
        },
      } as DocumentsApi,
      subscribe: () => () => undefined,
      subscribeConnected: (handler) => {
        connectedHandler = handler
        return () => undefined
      },
      onChange: () => undefined,
      onError: () => undefined,
    })
    await controller.load()
    controller.start()
    connectedHandler(true)
    await Promise.resolve()
    // The initial connect rides the load above; re-reporting `connected` must not
    // re-fetch, or every provider re-render would cost a list call.
    connectedHandler(true)
    await Promise.resolve()
    expect(listCalls).toBe(1)
    expect(controller.snapshot().connection).toBe("connected")

    connectedHandler(false)
    await Promise.resolve()
    expect(controller.snapshot().connection).toBe("reconnecting")

    connectedHandler(true)
    for (let turn = 0; turn < 8; turn++) await Promise.resolve()
    expect(listCalls).toBe(2)
    expect(controller.snapshot().connection).toBe("connected")
    controller.stop()
  })

  test("ignores nudges for other projects on the shared stream", async () => {
    let listCalls = 0
    let callback!: (event: DocumentChangedEvent) => void
    const controller = createDocumentIndexController({
      queries: [{ projectId: "p1" }],
      api: {
        list: async () => {
          listCalls++
          return [summary]
        },
      } as DocumentsApi,
      subscribe: (next) => {
        callback = next
        return () => undefined
      },
      onChange: () => undefined,
      onError: () => undefined,
    })
    await controller.load()
    controller.start()
    callback(changed("p2"))
    for (let turn = 0; turn < 8; turn++) await Promise.resolve()
    expect(listCalls).toBe(1)

    callback(changed("p1"))
    for (let turn = 0; turn < 8; turn++) await Promise.resolve()
    expect(listCalls).toBe(2)
    controller.stop()
  })
})
