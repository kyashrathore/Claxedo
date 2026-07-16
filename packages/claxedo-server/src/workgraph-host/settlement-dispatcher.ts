import { reportError } from "../observability/report"

export type SettlementTenant = {
  organizationId: string
  ownerUserId: string
}

export function settlementTenantKey(tenant: SettlementTenant) {
  return JSON.stringify([tenant.organizationId, tenant.ownerUserId])
}

export interface SettlementDispatcher {
  /** Fire-and-forget. Must never throw into the caller or block the response. */
  nudge(tenant: SettlementTenant): void
}

export const noopSettlementDispatcher: SettlementDispatcher = {
  nudge() {},
}

export function createNodeSettlementDispatcher(input: Readonly<{
  settle: (tenant: SettlementTenant) => unknown
  reportError?: typeof reportError
}>): SettlementDispatcher {
  const chains = new Map<string, Promise<void>>()
  const queued = new Map<string, SettlementTenant>()
  const errorReporter = input.reportError ?? reportError

  const start = (key: string, tenant: SettlementTenant): void => {
    const run = Promise.resolve()
      .then(() => input.settle(tenant))
      .then(() => undefined, (error) => {
        try {
          errorReporter(error, { tags: { source: "workgraph_settlement_dispatcher" } })
        } catch {
          // Reporting must not poison the per-tenant chain.
        }
      })
      .then(() => {
        const next = queued.get(key)
        if (!next) {
          if (chains.get(key) === run) chains.delete(key)
          return
        }
        queued.delete(key)
        start(key, next)
      })
    chains.set(key, run)
  }

  return {
    nudge(tenant) {
      const key = settlementTenantKey(tenant)
      if (chains.has(key)) {
        queued.set(key, tenant)
        return
      }
      start(key, tenant)
    },
  }
}
