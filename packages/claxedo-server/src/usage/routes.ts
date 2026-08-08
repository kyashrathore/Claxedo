import { Hono } from "hono"
import {
  ControlPlaneAuthError,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  type ClerkVerifier,
  type ControlPlaneAuthConfig,
} from "@claxedo/server-core/platform/auth/auth"
import type { UsageLedger } from "../platform/telemetry/product/metering"
import type { SqliteUsageLedger } from "./adapters/sqlite-usage-ledger"
import type { LocalHistorySnapshot } from "./adapters/token-tracker-local-history"
import type { UsageOutboxSync } from "./outbox-sync"
import { projectTokenTrackerCost, type PricedUsage } from "./adapters/token-tracker-pricing"
import type { TurnUsageRevision } from "./contracts"
import {
  centralProjectionSeries,
  groupUsageFacts,
  mergeUsageSeries,
  usageSeriesFromExternal,
  usageSeriesFromFacts,
  type UsageSeries,
} from "./projection"

const dimensions = new Set(["harness", "model", "location", "session", "workspace", "app"] as const)

const emptyCost = (): PricedUsage => ({
  estimatedUsd: 0,
  pricedTokens: 0,
  unpricedTokens: 0,
  catalog: { adapter: "tokentracker-cli", version: "0.75.1", source: "bundled-seed" },
})

async function priceFacts(facts: readonly TurnUsageRevision[]) {
  const total = emptyCost()
  for (const fact of facts) {
    const item = await projectTokenTrackerCost({
      source: fact.providerId,
      model: fact.modelId,
      tokens: {
        input: fact.tokens.input ?? 0,
        output: fact.tokens.output ?? 0,
        reasoning: fact.tokens.reasoning ?? 0,
        cacheRead: fact.tokens.cache.read ?? 0,
        cacheWrite: fact.tokens.cache.write ?? 0,
      },
    })
    total.estimatedUsd += item.estimatedUsd
    total.pricedTokens += item.pricedTokens
    total.unpricedTokens += item.unpricedTokens
    total.catalog = item.catalog
  }
  return total
}

async function priceExternal(rows: LocalHistorySnapshot["rows"]) {
  const total = emptyCost()
  for (const row of rows) {
    const item = await projectTokenTrackerCost({ source: row.app, model: row.model, tokens: row.tokens })
    total.estimatedUsd += item.estimatedUsd
    total.pricedTokens += item.pricedTokens
    total.unpricedTokens += item.unpricedTokens
    total.catalog = item.catalog
  }
  return total
}

function mergeCost(...costs: PricedUsage[]) {
  const total = emptyCost()
  for (const item of costs) {
    total.estimatedUsd += item.estimatedUsd
    total.pricedTokens += item.pricedTokens
    total.unpricedTokens += item.unpricedTokens
    total.catalog = item.catalog
  }
  return total
}

async function priceCentralBreakdown(value: unknown) {
  const rows = (value as { rows?: Array<Record<string, unknown>> } | null)?.rows ?? []
  const total = emptyCost()
  for (const row of rows) {
    const [source, ...modelParts] = String(row.value ?? "").split("/")
    const model = modelParts.join("/")
    if (!source || !model) continue
    const item = await projectTokenTrackerCost({
      source,
      model,
      tokens: {
        input: Number(row.input_tokens ?? 0),
        output: Number(row.output_tokens ?? 0),
        reasoning: Number(row.reasoning_tokens ?? 0),
        cacheRead: Number(row.cache_read_tokens ?? 0),
        cacheWrite: Number(row.cache_write_tokens ?? 0),
      },
    })
    total.estimatedUsd += item.estimatedUsd
    total.pricedTokens += item.pricedTokens
    total.unpricedTokens += item.unpricedTokens
    total.catalog = item.catalog
  }
  return total
}

export function UsageRoutes(input: {
  ledger: UsageLedger
  authConfig?: ControlPlaneAuthConfig
  verifier?: ClerkVerifier
}) {
  const app = new Hono()
  app.get("/", async (c) => {
    try {
      const auth = await controlPlaneAuthContext(c.req.raw, {
        config: input.authConfig,
        verifier: input.verifier,
      })
      if (auth.mode !== "signed" || !auth.user.orgId) {
        return c.json({ error: "signed_org_required", message: "A signed organization session is required" }, 401)
      }
      const since = Number(c.req.query("since"))
      const until = Number(c.req.query("until"))
      if (!Number.isFinite(since) || !Number.isFinite(until) || until < since) {
        return c.json({ error: "invalid_usage_range", message: "since and until must define a valid range" }, 400)
      }
      if (!input.ledger.usageDashboard) {
        return c.json({ error: "usage projection unavailable" }, 503)
      }
      const identity = { org_id: auth.user.orgId, user_id: auth.user.subject }
      const summary = await input.ledger.usageDashboard({ ...identity, since, until })
      const group = c.req.query("group")
      const claxedo = centralProjectionSeries(summary)
      const modelBreakdown = input.ledger.usageBreakdown
        ? await input.ledger.usageBreakdown({ ...identity, since, until, dimension: "model", limit: 100 })
        : undefined
      const claxedoCost = await priceCentralBreakdown(modelBreakdown)
      const base = {
        version: 1 as const,
        range: { since, until, timeZone: c.req.query("timezone") || "UTC" },
        quota: { status: "unavailable" as const },
        claxedo: { ...claxedo, cost: claxedoCost, status: "available" as const, scope: "cross-machine" as const },
        externalLocal: {
          ...usageSeriesFromExternal({ rows: [], since, until, timeZone: "UTC" }),
          status: "unavailable" as const,
          coverage: [],
          unclassified: 0,
          cost: emptyCost(),
        },
        total: claxedo,
        totalCost: claxedoCost,
        sync: { attempted: 0, delivered: 0, conflicts: 0, pending: 0 },
      }
      if (!group) return c.json(base)
      if (!dimensions.has(group as never)) {
        return c.json({ error: "invalid_usage_group", message: "group is invalid" }, 400)
      }
      const breakdown = group !== "app" && input.ledger.usageBreakdown
        ? await input.ledger.usageBreakdown({
            ...identity,
            since,
            until,
            dimension: group as "harness" | "model" | "location" | "session" | "workspace",
            ...(c.req.query("after") ? { after: c.req.query("after") } : {}),
            ...(c.req.query("limit") ? { limit: Number(c.req.query("limit")) } : {}),
          })
        : undefined
      return c.json({ ...base, ...(breakdown ? { breakdown } : {}) })
    } catch (error) {
      if (error instanceof ControlPlaneAuthError) {
        return c.json(controlPlaneAuthErrorBody(error), error.status as 400 | 401 | 403)
      }
      throw error
    }
  })
  return app
}

export type UnifiedUsageResponse = {
  version: 1
  range: { since: number; until: number; timeZone: string }
  quota: { status: "available" | "unavailable" | "degraded"; snapshot?: unknown; error?: string }
  claxedo: UsageSeries & { cost: PricedUsage; status: "available" | "stale" | "degraded"; scope: "local" | "cross-machine"; error?: string }
  externalLocal: UsageSeries & { cost: PricedUsage; status: "available" | "unavailable" | "degraded"; coverage: LocalHistorySnapshot["coverage"]; unclassified: number; error?: string }
  total: UsageSeries
  totalCost: PricedUsage
  sync: { attempted: number; delivered: number; conflicts: number; pending: number }
  breakdown?: unknown
}

export function LocalUsageRoutes(input: {
  local: SqliteUsageLedger
  central?: UsageLedger
  outbox: UsageOutboxSync
  identity(request: Request): Promise<{ org_id: string; user_id: string } | undefined>
  quota?: (refresh: boolean) => Promise<unknown>
  history?: (range: { since: number; until: number }) => Promise<LocalHistorySnapshot>
}) {
  const app = new Hono()
  app.get("/", async (c) => {
    const since = Number(c.req.query("since"))
    const until = Number(c.req.query("until"))
    const timeZone = c.req.query("timezone") || "UTC"
    if (!Number.isFinite(since) || !Number.isFinite(until) || until < since) {
      return c.json({ error: "invalid_usage_range" }, 400)
    }
    try { new Intl.DateTimeFormat("en", { timeZone }) } catch { return c.json({ error: "invalid_timezone" }, 400) }
    const identity = await input.identity(c.req.raw)
    const sync = await input.outbox.flush(identity).catch(() => ({ attempted: 0, delivered: 0, conflicts: 0, pending: -1 }))

    let central: unknown
    let centralError: string | undefined
    if (identity && input.central?.usageDashboard) {
      try { central = await input.central.usageDashboard({ ...identity, since, until }) }
      catch (error) { centralError = error instanceof Error ? error.message : String(error) }
    }
    const localFacts = central
      ? await input.local.pendingOutbox({ limit: 10_000 })
      : await input.local.current()
    const localSeries = usageSeriesFromFacts({ facts: localFacts, since, until, timeZone })
    const claxedoSeries = central ? mergeUsageSeries(centralProjectionSeries(central), localSeries) : localSeries
    const localCost = await priceFacts(localFacts)
    let centralCost = emptyCost()
    if (central && identity && input.central?.usageBreakdown) {
      try {
        centralCost = await priceCentralBreakdown(await input.central.usageBreakdown({
          ...identity, since, until, dimension: "model", limit: 100,
        }))
      } catch { /* cost coverage remains explicit and does not drop token totals */ }
    }
    const claxedoCost = mergeCost(centralCost, localCost)

    let history: LocalHistorySnapshot = { rows: [], coverage: [], classifiedClaxedo: 0, unclassified: 0 }
    let historyError: string | undefined
    if (input.history) {
      try { history = await input.history({ since, until }) }
      catch (error) { historyError = error instanceof Error ? error.message : String(error) }
    }
    const externalSeries = usageSeriesFromExternal({ rows: history.rows, since, until, timeZone })
    const externalCost = await priceExternal(history.rows)
    const group = c.req.query("group")
    let breakdown: unknown
    if (group && dimensions.has(group as never)) {
      const localRows = group === "app"
        ? history.rows.map((row) => ({ value: row.app, ...row.tokens }))
        : groupUsageFacts(localFacts, group as "harness" | "model" | "location" | "session" | "workspace")
      let centralRows: unknown
      if (group !== "app" && central && identity && input.central?.usageBreakdown) {
        try {
          centralRows = await input.central.usageBreakdown({
            ...identity, since, until,
            dimension: group as "harness" | "model" | "location" | "session" | "workspace",
          })
        } catch { /* summary remains usable */ }
      }
      breakdown = { dimension: group, localRows, ...(centralRows ? { central: centralRows } : {}) }
    }
    let quota: UnifiedUsageResponse["quota"] = { status: "unavailable" }
    if (input.quota) {
      try { quota = { status: "available", snapshot: await input.quota(c.req.query("refresh") === "1") } }
      catch (error) { quota = { status: "degraded", error: error instanceof Error ? error.message : String(error) } }
    }
    const response: UnifiedUsageResponse = {
      version: 1,
      range: { since, until, timeZone },
      quota,
      claxedo: {
        ...claxedoSeries,
        cost: claxedoCost,
        status: centralError ? "stale" : "available",
        scope: central ? "cross-machine" : "local",
        ...(centralError ? { error: centralError } : {}),
      },
      externalLocal: {
        ...externalSeries,
        cost: externalCost,
        status: historyError ? "degraded" : input.history ? "available" : "unavailable",
        coverage: history.coverage,
        unclassified: history.unclassified,
        ...(historyError ? { error: historyError } : {}),
      },
      total: mergeUsageSeries(claxedoSeries, externalSeries),
      totalCost: mergeCost(claxedoCost, externalCost),
      sync,
      ...(breakdown ? { breakdown } : {}),
    }
    return c.json(response)
  })
  return app
}
