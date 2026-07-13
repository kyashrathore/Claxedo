import type { NotificationID, WorkGraphContext, WorkGraphNotification, WorkGraphNotificationPage } from "../contracts"

export type NotificationStore = Readonly<{
  list(context: WorkGraphContext, input: Readonly<{ after?: string; limit: number; state?: "unread" | "read" }>): Promise<WorkGraphNotificationPage>
  read(context: WorkGraphContext, id: NotificationID): Promise<WorkGraphNotification | undefined>
  markRead(context: WorkGraphContext, input: Readonly<{ id: NotificationID; expectedVersion: number }>): Promise<WorkGraphNotification>
}>

export function createNotificationService(store: NotificationStore) {
  return {
    list(context: WorkGraphContext, input: Readonly<{ after?: string; limit?: number; state?: "unread" | "read" }> = {}) {
      requireOwner(context)
      return store.list(context, { ...input, limit: Math.max(1, Math.min(input.limit ?? 50, 100)) })
    },
    read(context: WorkGraphContext, id: NotificationID) {
      requireOwner(context)
      return store.read(context, id)
    },
    markRead(context: WorkGraphContext, input: Readonly<{ id: NotificationID; expectedVersion: number }>) {
      requireOwner(context)
      return store.markRead(context, input)
    },
  }
}

export type NotificationService = ReturnType<typeof createNotificationService>

export class NotificationVersionConflictError extends Error {}

function requireOwner(context: WorkGraphContext) {
  if (context.access.mode !== "owner") throw new Error("Owner access is required")
}
