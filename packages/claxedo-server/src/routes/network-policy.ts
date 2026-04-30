/**
 * Network policy routes — manage outbound egress allowlists.
 */

import { Hono } from "hono"
import { z } from "zod"
import {
  createPolicy,
  deletePolicy,
  getPolicy,
  listPolicies,
  resolveEffectivePolicy,
  updatePolicy,
  isTargetAllowed,
} from "../network/policy"
import { DEFAULT_ALLOWLIST } from "../network/types"

const createBody = z.object({
  workspace_id: z.string().optional(),
  runner: z.string().optional(),
  target: z.string().min(1),
  kind: z.enum(["host", "domain", "group"]),
  constraints: z
    .object({
      ports: z.array(z.number()).optional(),
      paths: z.array(z.string()).optional(),
      enabled: z.boolean().optional(),
    })
    .optional(),
})

const updateBody = createBody.partial()

const checkBody = z.object({
  workspace_id: z.string(),
  target: z.string().min(1),
})

export function NetworkPolicyRoutes() {
  return new Hono()
    .get("/", (c) => {
      const workspaceId = c.req.query("workspace_id")
      return c.json({ policies: listPolicies(workspaceId) })
    })
    .get("/groups", (c) => {
      return c.json({ groups: DEFAULT_ALLOWLIST })
    })
    .get("/effective/:workspaceId", (c) => {
      const allowed = resolveEffectivePolicy(c.req.param("workspaceId"))
      return c.json({ allowed })
    })
    .post("/check", async (c) => {
      const body = checkBody.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json({ error: body.error.message }, 400)
      return c.json({
        allowed: isTargetAllowed(body.data.workspace_id, body.data.target),
      })
    })
    .get("/:id", (c) => {
      const policy = getPolicy(c.req.param("id"))
      if (!policy) return c.json({ error: "Not found" }, 404)
      return c.json({ policy })
    })
    .post("/", async (c) => {
      const body = createBody.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json({ error: body.error.message }, 400)
      const result = createPolicy(body.data)
      if ("error" in result) return c.json({ error: result.error }, 400)
      return c.json({ policy: result }, 201)
    })
    .put("/:id", async (c) => {
      const body = updateBody.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json({ error: body.error.message }, 400)
      const result = updatePolicy(c.req.param("id"), body.data)
      if (!result) return c.json({ error: "Not found" }, 404)
      if ("error" in result) return c.json({ error: result.error }, 400)
      return c.json({ policy: result })
    })
    .delete("/:id", (c) => {
      const deleted = deletePolicy(c.req.param("id"))
      return c.json({ deleted })
    })
}
