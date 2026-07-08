import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { getWorkGraph } from "../model/registry"
import type { LoadoutKind, LoadoutScopeType } from "../model/types"

const scopeTypes = ["intake_item", "work_item", "mission", "repo", "role", "source_adapter", "task_kind", "system"] as const
const loadoutKinds = ["triage_mode", "model", "harness", "role", "source_context", "memory_provider", "auto_policy"] as const
const broadScopes: LoadoutScopeType[] = ["repo", "role", "source_adapter", "task_kind", "system"]

export function loadoutRouter() {
  const router = new Hono()

  router.get("/loadout", (c) => {
    const scopeType = c.req.query("scopeType") as LoadoutScopeType | undefined
    const scopeId = c.req.query("scopeId") ?? null
    const kind = c.req.query("kind") as LoadoutKind | undefined
    if (!scopeType || !kind) return c.json({ error: "scopeType and kind are required" }, 400)
    if (scopeType === "work_item" && scopeId) return c.json(getWorkGraph().resolveLoadoutSlot({ type: "work_item", id: scopeId }, kind))
    if (scopeType === "intake_item" && scopeId) return c.json(getWorkGraph().resolveLoadoutSlot({ type: "intake_item", id: scopeId }, kind))
    if (scopeType === "system") return c.json(getWorkGraph().resolveLoadoutSlot({ type: "system" }, kind))
    return c.json({ slots: getWorkGraph().getState().loadoutSlots })
  })

  router.put(
    "/loadout",
    zValidator("json", z.object({
      scope_type: z.enum(scopeTypes),
      scope_id: z.string().nullable().optional(),
      kind: z.enum(loadoutKinds),
      payload: z.record(z.string(), z.unknown()),
    })),
    (c) => {
      const body = c.req.valid("json")
      const scopeId = body.scope_id ?? null
      if (broadScopes.includes(body.scope_type)) {
        const result = getWorkGraph().propose({
          intentKind: "update_loadout",
          subjectType: "loadout_slot",
          subjectId: `${body.scope_type}:${scopeId ?? ""}:${body.kind}`,
          confidence: 1,
          evidenceMd: "Loadout route request",
          scopeType: body.scope_type,
          scopeId,
          loadoutKind: body.kind,
          payload: body.payload,
          broadScope: true,
        })
        return c.json(result, 202)
      }
      return c.json(getWorkGraph().setLoadoutSlot({
        scopeType: body.scope_type,
        scopeId,
        kind: body.kind,
        payload: body.payload,
      }))
    },
  )

  router.delete("/loadout/:id", (c) => {
    try {
      getWorkGraph().clearLoadoutSlot(c.req.param("id"))
      return c.json({ deleted: true })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404)
    }
  })

  return router
}
