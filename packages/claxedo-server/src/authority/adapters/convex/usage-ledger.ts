/**
 * Convex-backed `UsageLedger` — the authoritative half of the dual-write.
 *
 * `usageMetering.recordLlmTurn` is a `serviceMutation`, so this calls it the
 * way the rest of the control plane calls Convex: through a `ConvexExecutor`
 * with the deployment-held service token appended. The token is resolved at
 * CALL time rather than construction time so a deployment that gains its
 * secret after boot starts recording without a restart.
 */

import { anyApi } from "convex/server"
import { requireExecutor, requireServiceToken } from "../../../authority/adapters/convex/workspace-authority/executor"
import type { ConvexExecutor } from "../../../authority/adapters/convex/workspace-authority/types"
import { controlPlaneTimeoutMs, withTimeout } from "../../../authority/adapters/convex/timeout"
import type { LlmTurnRecord, UsageLedger } from "../../../platform/telemetry/product/metering"
import type { TurnUsageRevision } from "../../../usage/contracts"

const usageApi = anyApi as unknown as {
  usageMetering: {
    recordLlmTurn: unknown
    resolveWorkGraphAttribution: unknown
    ingestTurnUsageBatch: unknown
    usageDashboard: unknown
    usageDashboardPage: unknown
    usageBreakdown: unknown
  }
  sandboxLeases: { recordTenant: unknown }
}

export type ConvexUsageLedgerInput = {
  url?: string
  executor?: ConvexExecutor
  serviceToken?: string
}

function revisionArgs(fact: TurnUsageRevision) {
  return {
    host_id: fact.hostId,
    session_ref: fact.sessionRef,
    session_id: fact.sessionId,
    message_id: fact.messageId,
    revision: fact.revision,
    observed_at: fact.observedAt,
    ...(fact.completedAt === undefined ? {} : { completed_at: fact.completedAt }),
    settlement: fact.settlement,
    status: fact.status,
    location: fact.location,
    harness: fact.harness,
    provider_id: fact.providerId,
    model_id: fact.modelId,
    ...(fact.workspaceId ? { workspace_id: fact.workspaceId } : {}),
    input_tokens: fact.tokens.input,
    output_tokens: fact.tokens.output,
    reasoning_tokens: fact.tokens.reasoning,
    cache_read_tokens: fact.tokens.cache.read,
    cache_write_tokens: fact.tokens.cache.write,
    quality: {
      source: fact.quality.source,
      ...(fact.quality.observationKind ? { observation_kind: fact.quality.observationKind } : {}),
      ...(fact.quality.providerObservationId ? { provider_observation_id: fact.quality.providerObservationId } : {}),
      known_categories: fact.quality.knownCategories,
    },
  }
}

type UsageAcknowledgement = {
  status: "accepted" | "duplicate" | "stale" | "conflict"
  currentRevision?: number
  activated: boolean
}

function acknowledgements(result: unknown): UsageAcknowledgement[] {
  const rows = (result as { results?: Array<{ status?: unknown; current_revision?: unknown; activated?: unknown }> })?.results
  if (!rows) throw new Error("Convex usage ingest returned no acknowledgements")
  return rows.map((item) => {
    const status = item.status
    if (status !== "accepted" && status !== "duplicate" && status !== "stale" && status !== "conflict") {
      throw new Error("Convex usage ingest returned an invalid acknowledgement")
    }
    return {
      status,
      ...(typeof item.current_revision === "number" ? { currentRevision: item.current_revision } : {}),
      activated: item.activated === true,
    } satisfies UsageAcknowledgement
  })
}

type ProjectionRow = Record<string, number | string>

function mergeProjectionRows(target: Map<string, Record<string, number>>, rows: unknown, key: "date" | "value") {
  if (!Array.isArray(rows)) return
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue
    const row = raw as Record<string, unknown>
    const name = row[key]
    if (typeof name !== "string") continue
    const current = target.get(name) ?? {}
    for (const [field, value] of Object.entries(row)) {
      if (field !== key && typeof value === "number" && Number.isFinite(value)) current[field] = (current[field] ?? 0) + value
    }
    target.set(name, current)
  }
}

async function exactDashboardProjection(
  execute: () => ConvexExecutor,
  serviceArgs: <T extends Record<string, unknown>>(args: T) => T & { service_token: string },
  args: Parameters<NonNullable<UsageLedger["usageDashboard"]>>[0],
) {
  const totals: Record<string, number> = {}
  const daily = new Map<string, Record<string, number>>()
  const models = new Map<string, Record<string, number>>()
  const breakdown = new Map<string, Record<string, number>>()
  let cursor: string | undefined
  const seen = new Set<string>()
  do {
    const page = await withTimeout(execute().query(usageApi.usageMetering.usageDashboardPage, serviceArgs({
      org_id: args.org_id,
      user_id: args.user_id,
      since: args.since,
      until: args.until,
      time_zone: args.timeZone ?? "UTC",
      ...(args.dimension ? { dimension: args.dimension } : {}),
      ...(cursor ? { cursor } : {}),
    })), controlPlaneTimeoutMs("read")) as {
      totals?: Record<string, unknown>
      daily?: unknown
      models?: unknown
      breakdown?: unknown
      next?: unknown
    }
    if (!page || typeof page.totals !== "object" || !Array.isArray(page.daily)
      || !Array.isArray(page.models) || !Array.isArray(page.breakdown)) {
      throw new Error("Convex usage projection returned a malformed page")
    }
    for (const [field, value] of Object.entries(page.totals ?? {})) {
      if (typeof value === "number" && Number.isFinite(value)) totals[field] = (totals[field] ?? 0) + value
    }
    mergeProjectionRows(daily, page.daily, "date")
    mergeProjectionRows(models, page.models, "value")
    mergeProjectionRows(breakdown, page.breakdown, "value")
    const next = page.next
    if (typeof next === "string" && next.length > 0) {
      if (seen.has(next)) throw new Error("Convex usage projection repeated a cursor")
      seen.add(next)
      cursor = next
    } else cursor = undefined
  } while (cursor)
  const rows = (source: Map<string, Record<string, number>>, key: "date" | "value") => [...source]
    .map(([name, values]) => ({ [key]: name, ...values }) as ProjectionRow)
    .toSorted((a, b) => String(a[key]).localeCompare(String(b[key])))
  return { totals, daily: rows(daily, "date"), models: rows(models, "value"), breakdown: rows(breakdown, "value") }
}

export function createConvexUsageLedger(input: ConvexUsageLedgerInput = {}): UsageLedger {
  const execute = () => requireExecutor(input, undefined, { allowUnsigned: true })
  const serviceArgs = <T extends Record<string, unknown>>(args: T) => ({
    ...args,
    service_token: requireServiceToken(input),
  })
  return {
    resolveWorkGraphAttribution: async (identity) => {
      const executor = requireExecutor(input, undefined, { allowUnsigned: true })
      return await withTimeout(
        executor.query(usageApi.usageMetering.resolveWorkGraphAttribution, {
          ...identity,
          service_token: requireServiceToken(input),
        }),
        controlPlaneTimeoutMs("read"),
      ) as Awaited<ReturnType<NonNullable<UsageLedger["resolveWorkGraphAttribution"]>>>
    },
    recordLlmTurn: async (record: LlmTurnRecord & { org_id: string; user_id: string }) => {
      const executor = requireExecutor(input, undefined, { allowUnsigned: true })
      const result = await withTimeout(
        executor.mutation(usageApi.usageMetering.recordLlmTurn, {
          ...record,
          service_token: requireServiceToken(input),
        }),
        controlPlaneTimeoutMs("mutation"),
      )
      const activated = (result as { activated?: unknown } | null)?.activated
      return { activated: activated === true }
    },
    recordTurnUsageRevision: async ({ org_id, user_id, ...fact }) => {
      const result = await withTimeout(
        execute().mutation(usageApi.usageMetering.ingestTurnUsageBatch, serviceArgs({
          org_id,
          user_id,
          revisions: [revisionArgs(fact)],
        })),
        controlPlaneTimeoutMs("mutation"),
      )
      const item = acknowledgements(result)[0]
      if (!item) throw new Error("Convex usage ingest returned no acknowledgement")
      return item
    },
    recordTurnUsageBatch: async ({ org_id, user_id, revisions }) => acknowledgements(await withTimeout(
      execute().mutation(usageApi.usageMetering.ingestTurnUsageBatch, serviceArgs({
        org_id,
        user_id,
        revisions: revisions.map(revisionArgs),
      })),
      controlPlaneTimeoutMs("mutation"),
    )),
    usageDashboard: async (args) => args.timeZone
      ? await exactDashboardProjection(execute, serviceArgs, args)
      : await withTimeout(
        execute().query(usageApi.usageMetering.usageDashboard, serviceArgs(args)),
        controlPlaneTimeoutMs("read"),
      ),
    usageBreakdown: async (args) => await withTimeout(
      execute().query(usageApi.usageMetering.usageBreakdown, serviceArgs(args)),
      controlPlaneTimeoutMs("read"),
    ),
  }
}

/**
 * Attribute a sandbox lease to the tenant whose signed request caused it.
 *
 * Best-effort and self-composing: a deployment with no Convex authority or no
 * service token simply records nothing, because a create request must succeed
 * whether or not metering is configured. The caller fires this without
 * awaiting.
 *
 * The two identities are shaped the way `sandboxLeases.recordTenant` writes
 * them, so a caller cannot express a state the mutation would reject:
 *
 *  - `owner_subject` is REQUIRED. It is the concurrency cap's attribution key
 *    (`runtime_leases.owner_subject`) and every signed request carries a
 *    subject, so there is no legitimate call that omits it. A lease that was
 *    never stamped is a lease `sandboxLeases.countActiveForOrg` cannot see,
 *    which is a cap that silently does not bind.
 *  - `metering` is the org/user pair. It is ONE optional object rather than
 *    two optional fields so "both or neither" is unrepresentable-otherwise
 *    rather than merely checked: a personal-account token has no org claim, and
 *    a fact keyed on half a tenant — or on an org synthesized to fill the gap —
 *    corrupts every per-org aggregate, so those callers stamp an owner only.
 *    This is why the owner is its own column: it never reaches
 *    `sandbox_lease_events` or the rollups.
 */
export function recordSandboxLeaseTenant(
  input: ConvexUsageLedgerInput & {
    workspace_id: string
    owner_subject: string
    metering?: { org_id: string; user_id: string }
  },
): Promise<{ stamped: boolean }> {
  return (async () => {
    const executor = requireExecutor(input, undefined, { allowUnsigned: true })
    const result = await executor.mutation(usageApi.sandboxLeases.recordTenant, {
      workspace_id: input.workspace_id,
      owner_subject: input.owner_subject,
      // Omitted, not `undefined`: `recordTenant` writes the metering pair only
      // when both are present, and an explicit empty key is not the same thing
      // as an absent optional arg over the wire.
      ...(input.metering ? { org_id: input.metering.org_id, user_id: input.metering.user_id } : {}),
      service_token: requireServiceToken(input),
    })
    return { stamped: (result as { stamped?: unknown } | null)?.stamped === true }
  })().catch(() => ({ stamped: false }))
}
