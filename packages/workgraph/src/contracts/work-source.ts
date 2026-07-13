import { z } from "zod"
import { WorkGraphActorSchema } from "./context"
import { OwnerUserIDSchema, WorkSourceIDSchema, WorkSourceRevisionIDSchema } from "./ids"

export const ContentHashSchema = z.string().regex(/^[a-f0-9]{64}$/i).brand("ContentHash")
export type ContentHash = z.infer<typeof ContentHashSchema>

export const WorkSourceOriginSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("manual") }),
  z.strictObject({
    kind: z.literal("external"),
    provider: z.string().trim().min(1),
    externalId: z.string().trim().min(1),
    externalRevision: z.string().trim().min(1),
    url: z.string().url().optional(),
  }),
])
export type WorkSourceOrigin = z.infer<typeof WorkSourceOriginSchema>

export const WorkSourceRevisionDtoSchema = z
  .strictObject({
    id: WorkSourceRevisionIDSchema,
    workSourceId: WorkSourceIDSchema,
    revisionNumber: z.number().int().positive(),
    content: z.string().refine((content) => content.trim().length > 0, "Source content must contain non-whitespace text"),
    contentHash: ContentHashSchema,
    origin: WorkSourceOriginSchema,
    createdAt: z.number().int().nonnegative(),
    createdBy: WorkGraphActorSchema,
  })
  .readonly()
export type WorkSourceRevisionDto = z.infer<typeof WorkSourceRevisionDtoSchema>

export const WorkSourceDtoSchema = z.strictObject({
  id: WorkSourceIDSchema,
  ownerUserId: OwnerUserIDSchema,
  title: z.string().trim().min(1),
  latestRevisionId: WorkSourceRevisionIDSchema,
  revisionCount: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
})
export type WorkSourceDto = z.infer<typeof WorkSourceDtoSchema>

export const WorkSourceRevisionRefSchema = z.strictObject({
  workSourceId: WorkSourceIDSchema,
  revisionId: WorkSourceRevisionIDSchema,
  contentHash: ContentHashSchema,
})
export type WorkSourceRevisionRef = z.infer<typeof WorkSourceRevisionRefSchema>
