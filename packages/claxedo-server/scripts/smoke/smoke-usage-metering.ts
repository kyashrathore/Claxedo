/**
 * Deterministic release gate for the unified usage ledger.
 *
 * No provider, network, transcript, or developer home is touched. The fixture
 * starts at the canonical revision contract, then proves latest-revision
 * projection, cross-host aggregation, provenance-first overlap removal,
 * offline outbox convergence, privacy, and the committed 7/30/90-day budgets.
 */
import { performance } from "node:perf_hooks"
import type { TurnUsageRevision } from "@claxedo/server-core/usage/contracts"
import { createUsageOutboxSync } from "@claxedo/local-server/self-hosted-execution"
import {
  mergeUsageSeries,
  usageSeriesFromExternal,
  usageSeriesFromFacts,
} from "@claxedo/server-core/usage/projection"
import { createUsageProvenanceClassifier, tokenTrackerSourceForHarness } from "@claxedo/server-core/usage/provenance"
import { LocalUsageRoutes } from "@claxedo/server-core/usage/routes"

const DAY = 86_400_000
const NOW = Date.UTC(2026, 7, 9, 12)
const PROJECTION_BUDGET_MS = { 7: 40, 30: 80, 90: 180 } as const
const ROUTE_BUDGET_MS = 5_000
const HARNESSES = [
  "opencode",
  "claude-acp",
  "claude-sdk",
  "codex-acp",
  "codex-app-server",
  "cursor",
  "pi",
] as const

function invariant(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`usage smoke failed: ${message}`)
}

function fact(input: {
  harness: string
  hostId: string
  messageId: string
  observedAt: number
  revision?: number
  input?: number
  output?: number
  nativeSessionId?: string
  status?: TurnUsageRevision["status"]
  settlement?: TurnUsageRevision["settlement"]
}): TurnUsageRevision {
  const sessionId = `session-${input.hostId}-${input.harness}`
  return {
    sessionRef: `workspace:workspace-1:session:${sessionId}`,
    sessionId,
    messageId: input.messageId,
    revision: input.revision ?? 1,
    observedAt: input.observedAt,
    completedAt: input.observedAt + 10,
    settlement: input.settlement ?? "final",
    status: input.status ?? "completed",
    location: input.hostId === "host-central" ? "central" : "local",
    harness: input.harness,
    providerId: input.harness.startsWith("codex") ? "openai" : "anthropic",
    modelId: input.harness.startsWith("codex") ? "gpt-5.4" : "claude-sonnet-4-6",
    ...(input.nativeSessionId ? { nativeSessionId: input.nativeSessionId } : {}),
    workspaceId: "workspace-1",
    hostId: input.hostId,
    tokens: {
      input: input.input ?? 100,
      output: input.output ?? 20,
      reasoning: 5,
      cache: { read: 10, write: 2 },
    },
    quality: {
      source: "provider",
      observationKind: "cumulative",
      providerObservationId: `${input.messageId}-observation`,
      knownCategories: ["input", "output", "reasoning", "cache_read", "cache_write"],
    },
  }
}

function benchmarkFacts() {
  const rows: TurnUsageRevision[] = []
  for (let day = 0; day < 90; day += 1) {
    for (let turn = 0; turn < 120; turn += 1) {
      const harness = HARNESSES[turn % HARNESSES.length]!
      rows.push(fact({
        harness,
        hostId: `host-${turn % 3}`,
        messageId: `message-${day}-${turn}`,
        observedAt: NOW - day * DAY - turn,
      }))
    }
  }
  return rows
}

function assertPrivacy(rows: readonly TurnUsageRevision[]) {
  const encoded = JSON.stringify(rows).toLowerCase()
  for (const forbidden of ["prompt", "response", "credential", "authorization", "api_key", "/users/"]) {
    invariant(!encoded.includes(forbidden), `privacy boundary leaked ${forbidden}`)
  }
}

async function assertOfflineConvergence(revision: TurnUsageRevision) {
  let pending = [revision]
  let delivered = 0
  const local = {
    pendingOutbox: async () => pending,
    claimPending: async () => pending,
    markDelivered: async () => { pending = []; delivered += 1 },
    markConflict: async () => { throw new Error("unexpected conflict") },
  }
  const central = {
    recordLlmTurn: async () => ({ activated: false }),
    recordTurnUsageBatch: async ({ revisions }: { revisions: TurnUsageRevision[] }) =>
      revisions.map(() => ({ status: "accepted" as const, activated: false })),
  }
  const sync = createUsageOutboxSync({ local: local as never, central, limit: 100 })
  const offline = await sync.clearIdentity()
  invariant(offline.pending === 1 && offline.delivered === 0, "offline fact did not remain pending")
  const online = await sync.flush({ org_id: "org-1", user_id: "user-1" })
  invariant(online.delivered === 1 && delivered === 1 && pending.length === 0, "reconnect did not converge exactly once")
}

export async function runUsageMeteringSmoke() {
  const exact = HARNESSES.map((harness, index) => fact({
    harness,
    hostId: index % 2 === 0 ? "host-a" : "host-b",
    messageId: `exact-${harness}`,
    nativeSessionId: `native-${harness}`,
    observedAt: NOW - index * 1_000,
    input: 100 + index,
    output: 20 + index,
  }))
  const revised = fact({
    harness: "codex-app-server",
    hostId: "host-a",
    messageId: "exact-codex-app-server",
    nativeSessionId: "native-codex-app-server",
    observedAt: NOW - 4_000,
    revision: 2,
    input: 250,
    output: 50,
  })
  const projection = usageSeriesFromFacts({ facts: [...exact, revised, revised], since: NOW - 30 * DAY, until: NOW, timeZone: "UTC" })
  invariant(projection.totals.turnCount === HARNESSES.length, "revision replay changed the turn count")
  const expectedInput = exact.reduce((sum, row) => sum + (row.harness === "codex-app-server" ? 250 : row.tokens.input!), 0)
  invariant(projection.totals.input === expectedInput, "latest revision did not replace the earlier contribution")

  const manifest = exact.flatMap((row) => {
    const source = tokenTrackerSourceForHarness(row.harness)
    return source && row.nativeSessionId ? [{
      source,
      nativeSessionId: row.nativeSessionId,
      sessionRef: row.sessionRef,
      harness: row.harness,
      workspaceId: row.workspaceId,
      startedAt: 0,
    }] : []
  })
  const classify = createUsageProvenanceClassifier(manifest, {
    completeAfter: { claude: NOW - 90 * DAY, codex: NOW - 90 * DAY, opencode: NOW - 90 * DAY, pi: NOW - 90 * DAY },
  })
  invariant(classify({ source: "claude", nativeSessionId: "native-claude-sdk", observedAt: NOW }) === "claxedo", "Claxedo history was not excluded")
  invariant(classify({ source: "claude", nativeSessionId: "direct-claude", observedAt: NOW }) === "external", "direct history was not admitted")
  invariant(classify({ source: "cursor", nativeSessionId: "direct-cursor", observedAt: NOW }) === "unclassified", "incomplete source escaped quarantine")

  const external = usageSeriesFromExternal({
    rows: [{
      app: "claude",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      bucketStart: NOW - 500,
      nativeSessionId: "direct-claude",
      turnCount: 1,
      tokens: { input: 40, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    since: NOW - 30 * DAY,
    until: NOW,
    timeZone: "UTC",
  })
  const total = mergeUsageSeries(projection, external)
  invariant(total.totals.input === projection.totals.input + 40, "Total did not add the one classified direct event")
  invariant(total.totals.turnCount === projection.totals.turnCount + 1, "Total double-counted a Claxedo history event")
  invariant(new Set(exact.map((row) => row.hostId)).size === 2, "cross-machine fixture lost a host")

  await assertOfflineConvergence(exact[0]!)
  assertPrivacy(exact)

  const rows = benchmarkFacts()
  const timings: Record<string, number> = {}
  for (const days of [7, 30, 90] as const) {
    const started = performance.now()
    const result = usageSeriesFromFacts({ facts: rows, since: NOW - days * DAY, until: NOW, timeZone: "UTC" })
    const elapsed = performance.now() - started
    invariant(result.daily.length <= days + 1, `${days}d projection escaped its range`)
    invariant(elapsed <= PROJECTION_BUDGET_MS[days], `${days}d projection ${elapsed.toFixed(1)}ms exceeded ${PROJECTION_BUDGET_MS[days]}ms`)
    timings[`${days}d`] = Number(elapsed.toFixed(2))
  }

  // Exercise the production Hono handler too: ledger read, latest-revision
  // selection, pricing, provider breakdown, chart and JSON serialization.
  const route = LocalUsageRoutes({
    local: {
      current: async () => rows,
      pendingOutbox: async () => rows,
    } as never,
    identity: async () => undefined,
    outbox: {
      flush: async () => ({ attempted: 0, delivered: 0, conflicts: 0, pending: 0 }),
      clearIdentity: async () => ({ attempted: 0, delivered: 0, conflicts: 0, pending: 0 }),
    },
  })
  const routeStarted = performance.now()
  const routeResponse = await route.request(`/?since=${NOW - 90 * DAY}&until=${NOW}&timezone=UTC&view=claxedo&group=provider`)
  const routeElapsed = performance.now() - routeStarted
  invariant(routeResponse.ok, `production route returned ${routeResponse.status}`)
  const routeBody = await routeResponse.json() as { claxedo?: { totals?: { turnCount?: number } } }
  invariant(routeBody.claxedo?.totals?.turnCount === rows.length, "production route lost benchmark facts")
  invariant(routeElapsed <= ROUTE_BUDGET_MS, `production route ${routeElapsed.toFixed(1)}ms exceeded ${ROUTE_BUDGET_MS}ms`)

  return {
    harnesses: HARNESSES.length,
    exactTurns: projection.totals.turnCount,
    totalTurns: total.totals.turnCount,
    fixtureFacts: rows.length,
    projectionBudgetMs: PROJECTION_BUDGET_MS,
    projectionObservedMs: timings,
    productionRouteObservedMs: Number(routeElapsed.toFixed(2)),
    checks: ["revision-idempotency", "cross-machine", "overlap", "offline-recovery", "privacy", "7-30-90-budgets", "production-route"],
  }
}

if (import.meta.main) {
  const result = await runUsageMeteringSmoke()
  console.log(JSON.stringify({ status: "passed", ...result }, null, 2))
}
