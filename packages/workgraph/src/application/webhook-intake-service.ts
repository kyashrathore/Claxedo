import { ActorIDSchema, OwnerUserIDSchema, RequestIDSchema, type ConnectionID, type WorkGraphContext } from "../contracts"
import type { SourceProvider, SourceView } from "./source-view-service"

export type VerifiedWorkSourceSignal = Readonly<{
  connectionId: ConnectionID
  provider: SourceProvider
  deliveryId: string
  event: string
  attributes: Readonly<Record<string, string | readonly string[]>>
  receivedAt: number
}>

export type WebhookIntakeStore = Readonly<{
  begin(signal: VerifiedWorkSourceSignal): Promise<Readonly<
    { state: "completed" } | { state: "busy" } | { state: "acquired"; leaseId: string }
  >>
  listSourceViews(input: Readonly<{
    connectionId: ConnectionID
    provider: SourceProvider
    limit: number
  }>): Promise<readonly SourceView[]>
  complete(signal: VerifiedWorkSourceSignal, leaseId: string): Promise<boolean>
  fail(signal: VerifiedWorkSourceSignal, leaseId: string): Promise<boolean>
}>

export function createWebhookIntakeService(input: Readonly<{
  store: WebhookIntakeStore
  refresh(context: WorkGraphContext, sourceViewId: string): Promise<unknown>
  maxSourceViews?: number
}>) {
  const maxSourceViews = Math.max(1, Math.min(input.maxSourceViews ?? 32, 100))

  return {
    async receive(signal: VerifiedWorkSourceSignal) {
      const receipt = await input.store.begin(signal)
      if (receipt.state === "completed") return { accepted: false, reason: "already_processed" as const, refreshed: 0 }
      if (receipt.state === "busy") return { accepted: false, reason: "in_progress" as const, refreshed: 0 }
      try {
        const sourceViews = await input.store.listSourceViews({
          connectionId: signal.connectionId,
          provider: signal.provider,
          limit: maxSourceViews + 1,
        })
        if (sourceViews.length > maxSourceViews) throw new WebhookFanoutLimitError(maxSourceViews)
        const matched = sourceViews.filter((sourceView) => sourceView.status === "active" && matchesFilters(sourceView, signal))
        await Promise.all(matched.map((sourceView) => input.refresh(ownerContext(sourceView, signal), sourceView.id)))
        if (!await input.store.complete(signal, receipt.leaseId)) throw new WebhookLeaseLostError()
        return { accepted: true, reason: "processed" as const, refreshed: matched.length }
      } catch (error) {
        await input.store.fail(signal, receipt.leaseId)
        throw error
      }
    },
  }
}

export class WebhookFanoutLimitError extends Error {
  constructor(readonly limit: number) {
    super(`Verified webhook matched more than ${limit} Source Views`)
  }
}

export class WebhookLeaseLostError extends Error {
  constructor() {
    super("Webhook delivery lease was superseded before completion")
  }
}

export function matchesFilters(sourceView: SourceView, signal: VerifiedWorkSourceSignal) {
  if (sourceView.teamConnectionId !== signal.connectionId || sourceView.provider !== signal.provider) return false
  // Only stable routing dimensions are checked here. State, labels, and JQL
  // are re-evaluated by the provider refresh so transitions *out* of a view
  // still update the owner's intake state.
  const routingKeys = sourceView.provider === "github" ? ["repo"] : sourceView.provider === "linear" ? ["team"] : []
  return routingKeys.every((key) => {
    const expected = sourceView.filters[key]
    if (!expected) return true
    const actual = signal.attributes[key]
    if (Array.isArray(actual)) {
      const expectedValues = expected.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean)
      const actualValues = actual.map((value) => value.trim().toLowerCase())
      return expectedValues.every((value) => actualValues.includes(value))
    }
    return typeof actual === "string" && actual.trim().toLowerCase() === expected.trim().toLowerCase()
  })
}

function ownerContext(sourceView: SourceView, signal: VerifiedWorkSourceSignal): WorkGraphContext {
  return {
    ownerUserId: OwnerUserIDSchema.parse(sourceView.ownerUserId),
    actor: { type: "system", id: ActorIDSchema.parse("workgraph_webhook") },
    requestId: RequestIDSchema.parse(`webhook_${signal.deliveryId}`),
    access: { mode: "owner" },
  }
}
