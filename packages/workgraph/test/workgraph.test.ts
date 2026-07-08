import { describe, test, expect, beforeEach, afterEach } from "vitest"
import { WorkGraph } from "../src/model/workgraph"
import type { ConnectorInterface, NormalizedIssue } from "../src/connectors/interface"

function createGraph() {
  return new WorkGraph(":memory:")
}

function mockConnector(overrides?: Partial<ConnectorInterface>): ConnectorInterface {
  return {
    provider: "mock",
    hydrateIssue: async (params) => ({
      id: params.id ?? "ext-1",
      title: params.title ?? "External Issue",
      description: params.description ?? "External desc",
      status: params.status ?? "open",
      provider_url: params.url ?? "https://example.com/1",
    }),
    updateIssue: async () => {},
    addComment: async () => {},
    createIssue: async (_, data) => ({
      id: "new-ext",
      title: data.title,
      description: data.description,
      status: "open" as const,
      provider_url: "https://example.com/new",
    }),
    ...overrides,
  }
}

describe("WorkGraph", () => {
  let wg: WorkGraph

  beforeEach(() => {
    wg = createGraph()
  })

  afterEach(() => {
    wg.close()
  })

  describe("CRUD", () => {
    test("create returns a WorkItem with defaults", () => {
      const item = wg.create({ title: "Test item" })
      expect(item.id).toBeTruthy()
      expect(item.nodeType).toBe("task")
      expect(item.parentId).toBeNull()
      expect(item.title).toBe("Test item")
      expect(item.description).toBe("")
      expect(item.status).toBe("open")
      expect(item.labels).toEqual([])
      expect(item.createdAt).toBeTruthy()
      expect(item.updatedAt).toBeTruthy()
    })

    test("create with all fields", () => {
      const item = wg.create({
        title: "Full item",
        description: "A description",
        status: "in_progress",
        labels: ["bug", "p1"],
        context: "## Acceptance\n- must work",
        provider: "github",
        providerMeta: { owner: "acme", repo: "app", issueNumber: 42 },
        providerUrl: "https://github.com/acme/app/issues/42",
      })
      expect(item.status).toBe("in_progress")
      expect(item.labels).toEqual(["bug", "p1"])
      expect(item.provider).toBe("github")
      expect(item.providerMeta).toEqual({ owner: "acme", repo: "app", issueNumber: 42 })
      expect(item.providerUrl).toBe("https://github.com/acme/app/issues/42")
      expect(item.context).toContain("Acceptance")
    })

    test("get retrieves created item", () => {
      const item = wg.create({ title: "Get me" })
      const found = wg.get(item.id)
      expect(found).toBeDefined()
      expect(found!.title).toBe("Get me")
    })

    test("get returns undefined for nonexistent id", () => {
      expect(wg.get("nope")).toBeUndefined()
    })

    test("getAll returns all items", () => {
      wg.create({ title: "A" })
      wg.create({ title: "B" })
      wg.create({ title: "C" })
      expect(wg.getAll()).toHaveLength(3)
    })

    test("update modifies fields", () => {
      const item = wg.create({ title: "Original" })
      const updated = wg.update(item.id, { title: "Changed", labels: ["new"] })
      expect(updated.title).toBe("Changed")
      expect(updated.labels).toEqual(["new"])

      const fetched = wg.get(item.id)
      expect(fetched!.title).toBe("Changed")
    })

    test("update throws for nonexistent id", () => {
      expect(() => wg.update("ghost", { title: "x" })).toThrow("not found")
    })

    test("remove deletes item", () => {
      const item = wg.create({ title: "Doomed" })
      wg.remove(item.id)
      expect(wg.get(item.id)).toEqual(expect.objectContaining({
        id: item.id,
        deletedAt: expect.any(String),
      }))
      expect(wg.getUnblocked()).toHaveLength(0)
    })

    test("remove throws for nonexistent id", () => {
      expect(() => wg.remove("ghost")).toThrow("not found")
    })
  })

  describe("Dependencies", () => {
    test("addDep creates a dependency", () => {
      const a = wg.create({ title: "A" })
      const b = wg.create({ title: "B" })
      wg.addDep(a.id, b.id)

      const blockers = wg.getBlockedBy(b.id)
      expect(blockers).toHaveLength(1)
      expect(blockers[0].id).toBe(a.id)
    })

    test("removeDep removes a dependency", () => {
      const a = wg.create({ title: "A" })
      const b = wg.create({ title: "B" })
      wg.addDep(a.id, b.id)
      wg.removeDep(a.id, b.id)
      expect(wg.getBlockedBy(b.id)).toHaveLength(0)
    })

    test("addDep throws on cycle", () => {
      const a = wg.create({ title: "A" })
      const b = wg.create({ title: "B" })
      const c = wg.create({ title: "C" })
      wg.addDep(a.id, b.id)
      wg.addDep(b.id, c.id)
      expect(() => wg.addDep(c.id, a.id)).toThrow("cycle")
    })

    test("addDep throws for nonexistent source", () => {
      const b = wg.create({ title: "B" })
      expect(() => wg.addDep("ghost", b.id)).toThrow("not found")
    })

    test("addDep throws for nonexistent target", () => {
      const a = wg.create({ title: "A" })
      expect(() => wg.addDep(a.id, "ghost")).toThrow("not found")
    })

    test("addDep rejects cross-repo dependencies", () => {
      const a = wg.create({ title: "A", repoRef: "github:acme/a", repoLabel: "acme/a" })
      const b = wg.create({ title: "B", repoRef: "github:acme/b", repoLabel: "acme/b" })
      expect(() => wg.addDep(a.id, b.id)).toThrow("repo")
    })

    test("create rejects parent-child repo mismatches", () => {
      const mission = wg.create({ title: "Mission", nodeType: "mission", repoRef: "github:acme/a", repoLabel: "acme/a" })
      expect(() =>
        wg.create({ title: "Task", parentId: mission.id, repoRef: "github:acme/b", repoLabel: "acme/b" }),
      ).toThrow("repo")
    })

    test("remove item cleans up edges", () => {
      const a = wg.create({ title: "A" })
      const b = wg.create({ title: "B" })
      const c = wg.create({ title: "C" })
      wg.addDep(a.id, b.id)
      wg.addDep(b.id, c.id)

      wg.remove(b.id)

      expect(wg.getBlocking(a.id)).toHaveLength(0)
      expect(wg.getBlockedBy(c.id)).toHaveLength(0)
    })

    test("archive keeps item but removes it from active work", () => {
      const a = wg.create({ title: "A" })
      const b = wg.create({ title: "B" })
      wg.addDep(a.id, b.id)

      const next = wg.archive(a.id, "paused")
      expect(next.archivedAt).toBeTruthy()
      expect(wg.getUnblocked().map((item) => item.id)).toEqual([])
      expect(wg.isBlocked(b.id)).toBe(true)
    })
  })

  describe("Queries", () => {
    test("getUnblocked returns open items with no pending blockers", () => {
      const a = wg.create({ title: "A" })
      const b = wg.create({ title: "B" })
      wg.addDep(a.id, b.id)

      const unblocked = wg.getUnblocked()
      expect(unblocked).toHaveLength(1)
      expect(unblocked[0].id).toBe(a.id)
    })

    test("getUnblocked includes item after blocker completes", () => {
      const a = wg.create({ title: "A" })
      const b = wg.create({ title: "B" })
      wg.addDep(a.id, b.id)

      wg.update(a.id, { status: "done" })

      const unblocked = wg.getUnblocked()
      expect(unblocked).toHaveLength(1)
      expect(unblocked[0].id).toBe(b.id)
    })

    test("getBlockedBy returns upstream items", () => {
      const a = wg.create({ title: "A" })
      const b = wg.create({ title: "B" })
      const c = wg.create({ title: "C" })
      wg.addDep(a.id, c.id)
      wg.addDep(b.id, c.id)

      const blockers = wg.getBlockedBy(c.id)
      expect(blockers).toHaveLength(2)
      const ids = blockers.map((b) => b.id).sort()
      expect(ids).toContain(a.id)
      expect(ids).toContain(b.id)
    })

    test("getBlocking returns downstream items", () => {
      const a = wg.create({ title: "A" })
      const b = wg.create({ title: "B" })
      const c = wg.create({ title: "C" })
      wg.addDep(a.id, b.id)
      wg.addDep(a.id, c.id)

      const blocking = wg.getBlocking(a.id)
      expect(blocking).toHaveLength(2)
    })

    test("isBlocked returns true for blocked open items", () => {
      const a = wg.create({ title: "A" })
      const b = wg.create({ title: "B" })
      wg.addDep(a.id, b.id)

      expect(wg.isBlocked(b.id)).toBe(true)
      expect(wg.isBlocked(a.id)).toBe(false)
    })

    test("isBlocked returns false for non-open items", () => {
      const a = wg.create({ title: "A" })
      const b = wg.create({ title: "B" })
      wg.addDep(a.id, b.id)
      wg.update(b.id, { status: "in_progress" })
      expect(wg.isBlocked(b.id)).toBe(false)
    })
  })

  describe("Status flow", () => {
    test("open → in_progress → done", () => {
      const item = wg.create({ title: "Flow" })
      expect(item.status).toBe("open")

      const prog = wg.update(item.id, { status: "in_progress" })
      expect(prog.status).toBe("in_progress")

      const done = wg.update(item.id, { status: "done" })
      expect(done.status).toBe("done")
    })

    test("mission status follows descendants and synthesis", () => {
      const mission = wg.create({ title: "Review", nodeType: "mission", labels: ["mission"] })
      const a = wg.create({ title: "Review API", parentId: mission.id })
      const b = wg.create({ title: "Review UI", parentId: mission.id })
      const synth = wg.ensureSynthesis(mission.id)

      expect(synth?.nodeType).toBe("synthesis")
      expect(wg.get(mission.id)?.status).toBe("open")

      wg.update(a.id, { status: "in_progress" })
      expect(wg.get(mission.id)?.status).toBe("in_progress")

      wg.update(a.id, { status: "done" })
      wg.update(b.id, { status: "done" })
      expect(wg.get(mission.id)?.status).toBe("open")

      if (!synth) throw new Error("expected synthesis")
      wg.update(synth.id, { status: "done" })
      expect(wg.get(mission.id)?.status).toBe("done")
    })
  })

  describe("complete()", () => {
    test("marks item as done", async () => {
      const item = wg.create({ title: "Complete me" })
      const result = await wg.complete(item.id)
      expect(result.status).toBe("done")
      expect(wg.get(item.id)!.status).toBe("done")
    })

    test("complete unblocks downstream", async () => {
      const a = wg.create({ title: "A" })
      const b = wg.create({ title: "B" })
      wg.addDep(a.id, b.id)

      expect(wg.isBlocked(b.id)).toBe(true)
      await wg.complete(a.id)
      expect(wg.isBlocked(b.id)).toBe(false)
      expect(wg.getUnblocked()).toHaveLength(1)
    })

    test("complete unblocks the dependent without pushing provider comments (flat model)", async () => {
      const comments: string[] = []
      const connector = mockConnector({
        addComment: async (_, comment) => { comments.push(comment) },
      })

      const a = wg.create({ title: "Blocker" })
      const b = wg.create({
        title: "Blocked",
        providerMeta: { owner: "acme", repo: "app", issueNumber: 1 },
      })
      wg.addDep(a.id, b.id)
      expect(wg.isBlocked(b.id)).toBe(true)

      await wg.complete(a.id, connector)
      expect(wg.get(a.id)?.status).toBe("done")
      expect(wg.isBlocked(b.id)).toBe(false)
      // Between-card ordering is a human decision now — no downstream pushes.
      expect(comments).toHaveLength(0)
    })
  })

  describe("Events", () => {
    test("mutations emit events", () => {
      const a = wg.create({ title: "A" })
      wg.update(a.id, { title: "A2" })
      wg.remove(a.id)

      const events = wg.getEvents()
      expect(events.length).toBeGreaterThanOrEqual(3)
      expect(events[0].type).toBe("item_created")
      expect(events[1].type).toBe("item_updated")
      expect(events[2].type).toBe("item_updated")
      expect(JSON.parse(events[2].payload)).toEqual(expect.objectContaining({
        id: a.id,
        changes: expect.objectContaining({
          deletedAt: expect.any(String),
        }),
      }))
    })

    test("edge events are emitted", () => {
      const a = wg.create({ title: "A" })
      const b = wg.create({ title: "B" })
      wg.addDep(a.id, b.id)
      wg.removeDep(a.id, b.id)

      const events = wg.getEvents()
      const types = events.map((e) => e.type)
      expect(types).toContain("edge_added")
      expect(types).toContain("edge_removed")
    })

    test("getEvents with sinceSeq filters", () => {
      wg.create({ title: "A" })
      wg.create({ title: "B" })
      const events = wg.getEvents()
      expect(events).toHaveLength(2)

      const sinceFirst = wg.getEvents(events[0].seq)
      expect(sinceFirst).toHaveLength(1)
      expect(sinceFirst[0].type).toBe("item_created")
    })

    test("replayState matches getState", () => {
      const a = wg.create({ title: "A" })
      const b = wg.create({ title: "B" })
      wg.addDep(a.id, b.id)
      wg.update(a.id, { status: "done", labels: ["done"] })

      const live = wg.getState()
      const replayed = wg.replayState()

      expect(Object.keys(replayed.items)).toHaveLength(2)
      expect(replayed.items[a.id].status).toBe(live.items[a.id].status)
      expect(replayed.items[a.id].labels).toEqual(live.items[a.id].labels)
      expect(replayed.edges).toHaveLength(live.edges.length)
    })
  })

  describe("Persistence", () => {
    test("state survives close and reopen", () => {
      const tmpPath = `/tmp/workgraph-test-${Date.now()}.db`
      const wg1 = new WorkGraph(tmpPath)
      const a = wg1.create({ title: "Persistent" })
      const b = wg1.create({ title: "Also persistent" })
      wg1.addDep(a.id, b.id)
      wg1.update(a.id, { status: "done" })
      wg1.close()

      const wg2 = new WorkGraph(tmpPath)
      expect(wg2.getAll()).toHaveLength(2)
      expect(wg2.get(a.id)!.status).toBe("done")
      expect(wg2.getBlockedBy(b.id)).toHaveLength(1)
      expect(wg2.isBlocked(b.id)).toBe(false)
      expect(wg2.getUnblocked()).toHaveLength(1)
      wg2.close()

      // Clean up
      try { require("fs").unlinkSync(tmpPath) } catch {}
    })
  })

  describe("hydrateSlice", () => {
    test("imports issues from connector", async () => {
      const connector = mockConnector()
      const items = await wg.hydrateSlice(connector, [
        { id: "ext-1", title: "Issue 1", url: "https://example.com/1" },
        { id: "ext-2", title: "Issue 2", url: "https://example.com/2" },
        { id: "ext-3", title: "Issue 3", url: "https://example.com/3" },
      ])

      expect(items).toHaveLength(3)
      expect(wg.getAll()).toHaveLength(3)
      expect(items[0].provider).toBe("mock")
      expect(items[0].providerMeta).toEqual({ id: "ext-1", title: "Issue 1", url: "https://example.com/1" })
      expect(items[0].providerUrl).toBe("https://example.com/1")

      const events = wg.getEvents()
      expect(events.filter((e) => e.type === "item_hydrated")).toHaveLength(3)
    })

    test("maps connector statuses correctly", async () => {
      const connector = mockConnector({
        hydrateIssue: async (params) => ({
          id: params.id,
          title: "Issue",
          description: "",
          status: params.status,
          provider_url: "https://example.com",
        }),
      })

      const items = await wg.hydrateSlice(connector, [
        { id: "1", status: "open" },
        { id: "2", status: "in_progress" },
        { id: "3", status: "closed" },
      ])

      expect(items[0].status).toBe("open")
      expect(items[1].status).toBe("in_progress")
      expect(items[2].status).toBe("done")
    })

    test("hydrates parent-child hierarchy and adds synthesis for aggregate parents", async () => {
      const connector = mockConnector({
        hydrateIssue: async (params) => {
          if (params.id === "parent") {
            return {
              id: "parent",
              title: "Parent issue",
              description: "Aggregate work",
              status: "open",
              provider_url: "https://example.com/parent",
              external_key: "PARENT",
              child_external_keys: ["CHILD"],
              aggregate_only: true,
            }
          }
          return {
            id: "child",
            title: "Child issue",
            description: "",
            status: "open",
            provider_url: "https://example.com/child",
            external_key: "CHILD",
            parent_external_key: "PARENT",
          }
        },
      })

      const items = await wg.hydrateSlice(connector, [{ id: "parent" }, { id: "child" }])
      const parent = items.find((item) => item.title === "Parent issue")
      const child = items.find((item) => item.title === "Child issue")

      expect(parent?.nodeType).toBe("mission")
      expect(child?.parentId).toBe(parent?.id)
      expect(wg.getChildren(parent!.id).some((item) => item.nodeType === "synthesis")).toBe(true)
    })
  })

  describe("pushStatus", () => {
    test("pushes status to connector", async () => {
      const updates: any[] = []
      const connector = mockConnector({
        updateIssue: async (params, u) => { updates.push({ params, ...u }) },
      })

      const item = wg.create({
        title: "Push me",
        status: "done",
        providerMeta: { owner: "acme", repo: "app", issueNumber: 5 },
      })

      await wg.pushStatus(item.id, connector)
      expect(updates).toHaveLength(1)
      expect(updates[0].status).toBe("closed")
      expect(updates[0].params.issueNumber).toBe(5)
    })

    test("does not sync planned local work", async () => {
      const updates: any[] = []
      const notes: any[] = []
      const connector = mockConnector({
        updateIssue: async (_params, u) => { updates.push(u) },
        addComment: async (_params, body) => { notes.push(body) },
      })
      const item = wg.create({
        title: "Planned",
        provider: "github",
        providerMeta: { owner: "acme", repo: "app", issueNumber: 7 },
      })

      await wg.pushStatus(item.id, connector)
      expect(updates).toHaveLength(0)
      expect(notes).toHaveLength(0)
    })

    test("aggregates in-progress and blocked sync across linked items", async () => {
      const updates: any[] = []
      const notes: any[] = []
      const connector = mockConnector({
        updateIssue: async (_params, u) => { updates.push(u) },
        addComment: async (_params, body) => { notes.push(body) },
      })
      const a = wg.create({
        title: "A",
        status: "in_progress",
        provider: "github",
        providerMeta: { owner: "acme", repo: "app", issueNumber: 8 },
      })
      const b = wg.create({
        title: "B",
        provider: "github",
        providerMeta: { owner: "acme", repo: "app", issueNumber: 8 },
      })
      const c = wg.create({ title: "C" })
      wg.addDep(c.id, b.id)

      await wg.pushStatus(a.id, connector)
      expect(updates).toEqual([{ status: "in_progress" }])

      wg.update(a.id, { status: "done" })
      await wg.pushStatus(b.id, connector)
      expect(notes).toEqual(["Local WorkGraph work is blocked with no ready tasks remaining."])
    })

    test("syncs archive comment once for deleted or archived linked work", async () => {
      const updates: any[] = []
      const notes: any[] = []
      const connector = mockConnector({
        updateIssue: async (_params, u) => { updates.push(u) },
        addComment: async (_params, body) => { notes.push(body) },
      })
      const item = wg.create({
        title: "Gone",
        status: "in_progress",
        provider: "github",
        providerMeta: { owner: "acme", repo: "app", issueNumber: 9 },
      })

      wg.archive(item.id)
      wg.remove(item.id)
      await wg.pushStatus(item.id, connector)
      await wg.pushStatus(item.id, connector)

      expect(updates).toHaveLength(0)
      expect(notes).toEqual(["Local WorkGraph work was archived or deleted before completion."])
    })

    test("throws for item without providerMeta", async () => {
      const connector = mockConnector()
      const item = wg.create({ title: "No meta" })
      expect(wg.pushStatus(item.id, connector)).rejects.toThrow("providerMeta")
    })

    test("throws for nonexistent item", async () => {
      const connector = mockConnector()
      expect(wg.pushStatus("ghost", connector)).rejects.toThrow("not found")
    })
  })
})
