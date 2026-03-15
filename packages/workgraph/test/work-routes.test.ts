import { describe, it, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { createApp, initializeDb } from "../src/app"
import { resetWorkGraph } from "../src/workgraph-bridge"
import type { Hono } from "hono"

function json(body: any) {
  return {
    method: "POST" as const,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }
}

function jsonPatch(body: any) {
  return {
    method: "PATCH" as const,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }
}

describe("Work routes", () => {
  let db: InstanceType<typeof Database>
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    resetWorkGraph()
    db = new Database(":memory:")
    initializeDb(db)
    app = createApp(db)
  })

  // --- POST /work ---
  describe("POST /work", () => {
    it("should create a work item", async () => {
      const res = await app.request("/work", json({ title: "Fix bug #42" }))
      expect(res.status).toBe(201)

      const body = await res.json() as any
      expect(body).toHaveProperty("id")
      expect(body.title).toBe("Fix bug #42")
      expect(body.status).toBe("open")
    })

    it("should accept optional fields", async () => {
      const res = await app.request(
        "/work",
        json({
          title: "Add feature",
          description: "Detailed description",
          labels: ["frontend", "urgent"],
          context: "sprint-3",
        })
      )
      expect(res.status).toBe(201)

      const body = await res.json() as any
      expect(body.description).toBe("Detailed description")
      expect(body.labels).toEqual(["frontend", "urgent"])
      expect(body.context).toBe("sprint-3")
    })

    it("should return 400 for missing title", async () => {
      const res = await app.request("/work", json({}))
      expect(res.status).toBe(400)
    })
  })

  // --- GET /work ---
  describe("GET /work", () => {
    it("should list all work items", async () => {
      await app.request("/work", json({ title: "Item 1" }))
      await app.request("/work", json({ title: "Item 2" }))

      const res = await app.request("/work")
      expect(res.status).toBe(200)

      const items = await res.json() as any[]
      expect(items.length).toBe(2)
    })

    it("should filter by status", async () => {
      const createRes = await app.request("/work", json({ title: "Open item" }))
      const item = await createRes.json() as any

      await app.request(`/work/${item.id}`, jsonPatch({ status: "done" }))

      const res = await app.request("/work?status=open")
      const items = await res.json() as any[]
      expect(items.length).toBe(0)

      const doneRes = await app.request("/work?status=done")
      const doneItems = await doneRes.json() as any[]
      expect(doneItems.length).toBe(1)
    })
  })

  // --- GET /work/ready ---
  describe("GET /work/ready", () => {
    it("should return unblocked items without active runs", async () => {
      await app.request("/work", json({ title: "Ready item" }))
      const res = await app.request("/work/ready")
      expect(res.status).toBe(200)

      const items = await res.json() as any[]
      expect(items.length).toBe(1)
      expect(items[0].title).toBe("Ready item")
    })
  })

  // --- GET /work/:id ---
  describe("GET /work/:id", () => {
    it("should return a specific item", async () => {
      const createRes = await app.request("/work", json({ title: "Specific" }))
      const item = await createRes.json() as any

      const res = await app.request(`/work/${item.id}`)
      expect(res.status).toBe(200)

      const body = await res.json() as any
      expect(body.id).toBe(item.id)
      expect(body.title).toBe("Specific")
    })

    it("should return 404 for unknown id", async () => {
      const res = await app.request("/work/nonexistent")
      expect(res.status).toBe(404)
    })
  })

  // --- PATCH /work/:id ---
  describe("PATCH /work/:id", () => {
    it("should update an item", async () => {
      const createRes = await app.request("/work", json({ title: "Original" }))
      const item = await createRes.json() as any

      const res = await app.request(
        `/work/${item.id}`,
        jsonPatch({ title: "Updated", status: "in_progress" })
      )
      expect(res.status).toBe(200)

      const body = await res.json() as any
      expect(body.title).toBe("Updated")
      expect(body.status).toBe("in_progress")
    })

    it("should return 404 for unknown id", async () => {
      const res = await app.request("/work/nonexistent", jsonPatch({ title: "X" }))
      expect(res.status).toBe(404)
    })
  })

  // --- DELETE /work/:id ---
  describe("DELETE /work/:id", () => {
    it("should delete an item", async () => {
      const createRes = await app.request("/work", json({ title: "To delete" }))
      const item = await createRes.json() as any

      const res = await app.request(`/work/${item.id}`, { method: "DELETE" })
      expect(res.status).toBe(200)

      const body = await res.json() as any
      expect(body.deleted).toBe(true)

      // Verify it's gone
      const getRes = await app.request(`/work/${item.id}`)
      expect(getRes.status).toBe(404)
    })

    it("should return 404 for unknown id", async () => {
      const res = await app.request("/work/nonexistent", { method: "DELETE" })
      expect(res.status).toBe(404)
    })
  })

  // --- Dependency management ---
  describe("POST /work/:id/dep", () => {
    it("should add a dependency", async () => {
      const aRes = await app.request("/work", json({ title: "Blocker" }))
      const a = await aRes.json() as any

      const bRes = await app.request("/work", json({ title: "Blocked" }))
      const b = await bRes.json() as any

      const res = await app.request(`/work/${b.id}/dep`, json({ blocking_id: a.id }))
      expect(res.status).toBe(201)

      const body = await res.json() as any
      expect(body.blocking).toBe(a.id)
      expect(body.blocked).toBe(b.id)
    })

    it("should reject cyclic dependencies", async () => {
      const aRes = await app.request("/work", json({ title: "A" }))
      const a = await aRes.json() as any

      const bRes = await app.request("/work", json({ title: "B" }))
      const b = await bRes.json() as any

      // A blocks B
      await app.request(`/work/${b.id}/dep`, json({ blocking_id: a.id }))

      // B blocks A → cycle
      const res = await app.request(`/work/${a.id}/dep`, json({ blocking_id: b.id }))
      expect(res.status).toBe(400)
    })
  })

  describe("DELETE /work/:id/dep/:blocking_id", () => {
    it("should remove a dependency", async () => {
      const aRes = await app.request("/work", json({ title: "Blocker" }))
      const a = await aRes.json() as any

      const bRes = await app.request("/work", json({ title: "Blocked" }))
      const b = await bRes.json() as any

      await app.request(`/work/${b.id}/dep`, json({ blocking_id: a.id }))

      const res = await app.request(`/work/${b.id}/dep/${a.id}`, { method: "DELETE" })
      expect(res.status).toBe(200)

      const body = await res.json() as any
      expect(body.deleted).toBe(true)
    })
  })

  // --- Scratchpads ---
  describe("GET /work/:id/scratchpads", () => {
    it("should return scratchpads for an item", async () => {
      const createRes = await app.request("/work", json({ title: "Item" }))
      const item = await createRes.json() as any

      const res = await app.request(`/work/${item.id}/scratchpads`)
      expect(res.status).toBe(200)

      const pads = await res.json() as any[]
      expect(pads).toEqual([])
    })

    it("should return 404 for unknown item", async () => {
      const res = await app.request("/work/nonexistent/scratchpads")
      expect(res.status).toBe(404)
    })
  })

  describe("POST /work/:id/scratchpads", () => {
    it("should write a scratchpad entry", async () => {
      const createRes = await app.request("/work", json({ title: "Item" }))
      const item = await createRes.json() as any

      const res = await app.request(
        `/work/${item.id}/scratchpads`,
        json({ content: "Some notes", priority: "fyi" })
      )
      expect(res.status).toBe(201)

      const body = await res.json() as any
      expect(body).toHaveProperty("id")
      expect(body.content).toBe("Some notes")
      expect(body.priority).toBe("fyi")
      expect(body.workItemId).toBe(item.id)
    })

    it("should default priority to fyi", async () => {
      const createRes = await app.request("/work", json({ title: "Item" }))
      const item = await createRes.json() as any

      const res = await app.request(
        `/work/${item.id}/scratchpads`,
        json({ content: "Just a note" })
      )
      expect(res.status).toBe(201)

      const body = await res.json() as any
      expect(body.priority).toBe("fyi")
    })

    it("should return 404 for unknown item", async () => {
      const res = await app.request(
        "/work/nonexistent/scratchpads",
        json({ content: "Note" })
      )
      expect(res.status).toBe(404)
    })

    it("should list scratchpads after writing", async () => {
      const createRes = await app.request("/work", json({ title: "Item" }))
      const item = await createRes.json() as any

      await app.request(
        `/work/${item.id}/scratchpads`,
        json({ content: "Note 1" })
      )
      await app.request(
        `/work/${item.id}/scratchpads`,
        json({ content: "Note 2", priority: "blocking" })
      )

      const res = await app.request(`/work/${item.id}/scratchpads`)
      const pads = await res.json() as any[]
      expect(pads.length).toBe(2)
    })
  })
})
