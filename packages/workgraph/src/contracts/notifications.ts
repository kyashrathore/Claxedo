import { z } from "zod"
import { OwnerUserIDSchema, RecapIDSchema, StreamIDSchema } from "./ids"
import { NotificationPageCursorSchema } from "./page-cursors"

export const NotificationIDSchema = z.string().trim().min(1).brand("NotificationID")
export type NotificationID = z.infer<typeof NotificationIDSchema>

export const WorkGraphNotificationSchema = z.strictObject({
  id: NotificationIDSchema,
  ownerUserId: OwnerUserIDSchema,
  version: z.number().int().positive(),
  kind: z.literal("actionable_recap"),
  state: z.enum(["unread", "read"]),
  streamId: StreamIDSchema,
  recapId: RecapIDSchema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  readAt: z.number().int().nonnegative().optional(),
})
export type WorkGraphNotification = z.infer<typeof WorkGraphNotificationSchema>

export const WorkGraphNotificationPageSchema = z.strictObject({
  notifications: z.array(WorkGraphNotificationSchema),
  hasMore: z.boolean(),
  nextCursor: NotificationPageCursorSchema.optional(),
})
export type WorkGraphNotificationPage = z.infer<typeof WorkGraphNotificationPageSchema>
