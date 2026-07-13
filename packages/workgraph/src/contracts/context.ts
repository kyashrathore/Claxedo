import { z } from "zod"
import { ActorIDSchema, OwnerUserIDSchema, RequestIDSchema } from "./ids"

export const WorkGraphActorSchema = z.strictObject({
  type: z.enum(["user", "agent", "system"]),
  id: ActorIDSchema,
})
export type WorkGraphActor = z.infer<typeof WorkGraphActorSchema>

export const WorkGraphAccessSchema = z.strictObject({
  mode: z.enum(["owner", "shared_read"]),
})
export type WorkGraphAccess = z.infer<typeof WorkGraphAccessSchema>

export const WorkGraphContextSchema = z.strictObject({
  ownerUserId: OwnerUserIDSchema,
  actor: WorkGraphActorSchema,
  requestId: RequestIDSchema,
  access: WorkGraphAccessSchema,
})
export type WorkGraphContext = z.infer<typeof WorkGraphContextSchema>

