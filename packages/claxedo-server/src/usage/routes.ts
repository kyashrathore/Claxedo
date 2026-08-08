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
import {
  centralProjectionSeries,
  groupUsageFacts,
  mergeUsageSeries,
  usageSeriesFromExternal,
  usageSeriesFromFacts,
  type UsageSeries,
} from "./projection"

const dimensions = new Set(["harness", "model", "location", "session", "workspace", "app"] as const)

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
      const base = {
        version: 1 as const,
        range: { since, until, timeZone: c.req.query("timezone") || "UTC" },
        quota: { status: "unavailable" as const },
        claxedo: { ...claxedo, status: "available" as const, scope: "cross-machine" as const },
        externalLocal: {
          ...usageSeriesFromExternal({ rows: [], since, until, timeZone: "UTC" }),
          status: "unavailable" as const,
          coverage: [],
          unclassified: 0,
        },
        total: claxedo,
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
  claxedo: UsageSeries & { status: "available" | "stale" | "degraded"; scope: "local" | "cross-machine"; error?: string }
  externalLocal: UsageSeries & { status: "available" | "unavailable" | "degraded"; coverage: LocalHistorySnapshot["coverage"]; unclassified: number; error?: string }
  total: UsageSeries
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

    let history: LocalHistorySnapshot = { rows: [], coverage: [], classifiedClaxedo: 0, unclassified: 0 }
    let historyError: string | undefined
    if (input.history) {
      try { history = await input.history({ since, until }) }
      catch (error) { historyError = error instanceof Error ? error.message : String(error) }
    }
    const externalSeries = usageSeriesFromExternal({ rows: history.rows, since, until, timeZone })
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
        status: centralError ? "stale" : "available",
        scope: central ? "cross-machine" : "local",
        ...(centralError ? { error: centralError } : {}),
      },
      externalLocal: {
        ...externalSeries,
        status: historyError ? "degraded" : input.history ? "available" : "unavailable",
        coverage: history.coverage,
        unclassified: history.unclassified,
        ...(historyError ? { error: historyError } : {}),
      },
      total: mergeUsageSeries(claxedoSeries, externalSeries),
      sync,
      ...(breakdown ? { breakdown } : {}),
    }
    return c.json(response)
  })
  return app
}
