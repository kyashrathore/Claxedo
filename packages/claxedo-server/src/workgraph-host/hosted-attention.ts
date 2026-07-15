import { createAttentionAcknowledgementService } from "@claxedo/workgraph/hosted"
import { AttentionAcknowledgementSchema, type WorkGraphContext } from "@claxedo/workgraph/contracts"
import { workGraphConvexApi } from "./convex-api"

type Executor = Readonly<{
  mutation(fn: unknown, args: Record<string, unknown>): Promise<unknown>
}>

export function createHostedAttentionAcknowledgementService(input: Readonly<{
  executor: Executor
  serviceToken: string
  now?: () => number
}>) {
  const acknowledge = async (context: WorkGraphContext, type: "mark_all_read" | "clear") =>
    AttentionAcknowledgementSchema.parse(await input.executor.mutation(workGraphConvexApi.workgraphAttention.acknowledgeForService, {
      service_token: input.serviceToken,
      organization_id: context.organizationId,
      owner_subject: context.ownerUserId,
      operation: { type, now: (input.now ?? Date.now)() },
    }))

  return createAttentionAcknowledgementService({
    markAllRead: (context) => acknowledge(context, "mark_all_read"),
    clear: (context) => acknowledge(context, "clear"),
  })
}
