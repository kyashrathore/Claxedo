import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { getWorkGraph, getReadyWork } from "../orchestrator/workgraph-bridge"

/**
 * Creates a Hono sub-router for WorkGraph CRUD + query endpoints.
 */
export function workRouter() {
  const router = new Hono()

  // --- GET /work --- list all items (optional ?status filter)
  router.get("/work", async (c) => {
    const wg = getWorkGraph()
    let items = wg.getAll()
    const status = c.req.query("status")
    if (status) {
      items = items.filter((it) => it.status === status)
    }
    return c.json(items)
  })

  // --- GET /work/ready --- unblocked items without active runs
  router.get("/work/ready", async (c) => {
    const items = getReadyWork()
    return c.json(items)
  })

  // --- POST /work --- create a work item
  router.post(
    "/work",
    zValidator(
      "json",
      z.object({
        title: z.string().min(1),
        description: z.string().optional(),
        labels: z.array(z.string()).optional(),
        context: z.string().optional(),
      })
    ),
    async (c) => {
      const { title, description, labels, context } = c.req.valid("json")
      const wg = getWorkGraph()
      const item = wg.create({ title, description, labels, context })
      return c.json(item, 201)
    }
  )

  // --- GET /work/:id --- get single item
  router.get("/work/:id", async (c) => {
    const id = c.req.param("id")
    const wg = getWorkGraph()
    const item = wg.get(id)
    if (!item) {
      return c.json({ error: "Work item not found" }, 404)
    }
    return c.json(item)
  })

  // --- PATCH /work/:id --- update item
  router.patch(
    "/work/:id",
    zValidator(
      "json",
      z.object({
        title: z.string().min(1).optional(),
        status: z.enum(["open", "in_progress", "done"]).optional(),
        labels: z.array(z.string()).optional(),
        context: z.string().optional(),
        description: z.string().optional(),
      })
    ),
    async (c) => {
      const id = c.req.param("id")
      const changes = c.req.valid("json")
      const wg = getWorkGraph()
      try {
        const item = wg.update(id, changes)
        return c.json(item)
      } catch (err: any) {
        return c.json({ error: err.message }, 404)
      }
    }
  )

  // --- DELETE /work/:id --- remove item
  router.delete("/work/:id", async (c) => {
    const id = c.req.param("id")
    const wg = getWorkGraph()
    try {
      wg.remove(id)
      return c.json({ deleted: true })
    } catch (err: any) {
      return c.json({ error: err.message }, 404)
    }
  })

  // --- POST /work/:id/dep --- add dependency
  router.post(
    "/work/:id/dep",
    zValidator(
      "json",
      z.object({
        blocking_id: z.string().min(1),
      })
    ),
    async (c) => {
      const blocked = c.req.param("id")
      const { blocking_id } = c.req.valid("json")
      const wg = getWorkGraph()
      try {
        wg.addDep(blocking_id, blocked)
        return c.json({ blocking: blocking_id, blocked }, 201)
      } catch (err: any) {
        return c.json({ error: err.message }, 400)
      }
    }
  )

  // --- DELETE /work/:id/dep/:blocking_id --- remove dependency
  router.delete("/work/:id/dep/:blocking_id", async (c) => {
    const blocked = c.req.param("id")
    const blocking_id = c.req.param("blocking_id")
    const wg = getWorkGraph()
    try {
      wg.removeDep(blocking_id, blocked)
      return c.json({ deleted: true })
    } catch (err: any) {
      return c.json({ error: err.message }, 400)
    }
  })

  // --- GET /work/:id/scratchpads --- get scratchpads for item
  router.get("/work/:id/scratchpads", async (c) => {
    const id = c.req.param("id")
    const wg = getWorkGraph()
    const item = wg.get(id)
    if (!item) {
      return c.json({ error: "Work item not found" }, 404)
    }
    const scratchpads = wg.getScratchpads(id)
    return c.json(scratchpads)
  })

  // --- POST /work/:id/scratchpads --- write scratchpad
  router.post(
    "/work/:id/scratchpads",
    zValidator(
      "json",
      z.object({
        content: z.string().min(1),
        priority: z.enum(["fyi", "blocking", "scope_change"]).optional(),
      })
    ),
    async (c) => {
      const id = c.req.param("id")
      const { content, priority } = c.req.valid("json")
      const wg = getWorkGraph()
      try {
        const entry = wg.writeScratchpad({ workItemId: id, content, priority })
        return c.json(entry, 201)
      } catch (err: any) {
        return c.json({ error: err.message }, 404)
      }
    }
  )

  return router
}
