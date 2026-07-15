import { createNotificationService, NotificationVersionConflictError, type NotificationStore } from "@claxedo/workgraph/hosted"
import { NotificationPageCursorError, type NotificationPageCursorErrorReason, type WorkGraphContext } from "@claxedo/workgraph/contracts"
import { workGraphConvexApi } from "./convex-api"

type Executor = Readonly<{ query(fn: unknown, args: Record<string, unknown>): Promise<unknown>; mutation(fn: unknown, args: Record<string, unknown>): Promise<unknown> }>
export function createHostedNotificationService(input: Readonly<{ executor: Executor; serviceToken: string }>) {
  const read = (context: WorkGraphContext, query: Record<string, unknown>) => input.executor.query(workGraphConvexApi.workgraphNotifications.readForService, { service_token: input.serviceToken, organization_id: context.organizationId, owner_subject: context.ownerUserId, query })
  const store: NotificationStore = {
    async list(context, query) {
      try {
        return await read(context, { kind: "list", ...query }) as Awaited<ReturnType<NotificationStore["list"]>>
      } catch (error) {
        const reason = notificationCursorReason(error)
        if (reason) throw new NotificationPageCursorError(reason)
        throw error
      }
    },
    async read(context, id) { const value = await read(context, { kind: "read", id }); return value === null ? undefined : value as Awaited<ReturnType<NotificationStore["read"]>> },
    async markRead(context, request) {
      const result = await input.executor.mutation(workGraphConvexApi.workgraphNotifications.executeForService, { service_token: input.serviceToken, organization_id: context.organizationId, owner_subject: context.ownerUserId, operation: { type: "mark_read", ...request, now: Date.now() } }) as { state: string; notification?: Awaited<ReturnType<NotificationStore["markRead"]>> }
      if (result.state !== "updated" || !result.notification) throw new NotificationVersionConflictError()
      return result.notification
    },
  }
  return createNotificationService(store)
}

function notificationCursorReason(error: unknown): NotificationPageCursorErrorReason | undefined {
  if (error instanceof NotificationPageCursorError) return error.reason
  const value = error && typeof error === "object" && "data" in error ? error.data : error
  if (!value || typeof value !== "object" || !("code" in value) || value.code !== "cursor_invalid" || !("reason" in value)) return
  if (value.reason === "invalid" || value.reason === "owner_mismatch" || value.reason === "filter_mismatch") return value.reason
}
