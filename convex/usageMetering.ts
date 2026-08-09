// W5 usage metering — the authoritative half of the owner's two cost questions
// ("how much sandbox compute does my average user consume?", "how many AI
// tokens?") and the activation moment that makes both attributable.
//
// D1: this module is the SOURCE OF TRUTH. The same facts are captured to
// PostHog for analysis, but every `capture()` in this codebase is deliberately
// best-effort — a dropped event must never break the turn it observes — which
// is right for product analytics and wrong for a number a paid plan may later
// be gated on. So the server dual-writes: PostHog for the view, these tables
// for the record.
//
// Security law (2026-07-27-003 §5): the Convex function IS the boundary — the
// deployment URL ships inside the web and desktop bundles, so anything not
// built from a service/internal builder is callable by anyone who opens
// devtools. Every function here is `serviceMutation`/`serviceQuery` (verified
// machine principal) or `cronMutation` (internal visibility — not callable by
// any client at all).
//
// And every table here ships a READER. `convex/auditEvents.ts` is write-only
// with zero readers anywhere in the repo; a metering table that nobody can
// query answers no question at all.

import { v } from "convex/values"
import { MASTER_SESSION_PREFIX, RUN_SESSION_PREFIX } from "@claxedo/workgraph/contracts"
import { cronMutation, orgByClerkOrgId, serviceMutation, serviceQuery, userByClerkSubject } from "./model"
import { usageDate } from "./sandboxLeases"

/**
 * Rows one rollup read returns (W5 index pass).
 *
 * The reader is index-ranged by org and/or date window, so this only binds a
 * caller who asks for an unbounded window across every org — a reporting
 * question, not a runtime one. Returning the range's first page beats throwing
 * once the rollup table outgrows Convex's per-transaction read cap; a caller
 * who needs more should narrow the window, which is what the index rewards.
 */
const USAGE_ROLLUP_ROW_LIMIT = 5_000
const MAX_DASHBOARD_RANGE_MS = 90 * 86_400_000

const turnStatus = v.union(v.literal("ok"), v.literal("error"))
const sourcePlanningSessionPrefix = "ses_workgraph_source_plan_job_"
const tokenCategory = v.union(
  v.literal("input"), v.literal("output"), v.literal("reasoning"),
  v.literal("cache_read"), v.literal("cache_write"),
)
const settlement = v.union(
  v.literal("provisional"), v.literal("final"), v.literal("partial"),
  v.literal("unavailable"), v.literal("recovered"),
)
const usageStatus = v.union(
  v.literal("running"), v.literal("completed"), v.literal("error"), v.literal("stopped"),
  v.literal("interrupted_by_steer"), v.literal("process_lost"),
)
const usageLocation = v.union(
  v.literal("local"), v.literal("central"), v.literal("cloud-workspace"), v.literal("user-hosted"),
)
const nullableTokens = v.union(v.number(), v.null())
const turnUsageRevision = v.object({
  host_id: v.optional(v.string()),
  session_ref: v.string(),
  session_id: v.string(),
  message_id: v.string(),
  stream_id: v.optional(v.string()),
  run_id: v.optional(v.string()),
  work_item_id: v.optional(v.string()),
  revision: v.number(),
  observed_at: v.number(),
  completed_at: v.optional(v.number()),
  settlement,
  status: usageStatus,
  location: usageLocation,
  harness: v.string(),
  provider_id: v.string(),
  model_id: v.string(),
  workspace_id: v.optional(v.string()),
  input_tokens: nullableTokens,
  output_tokens: nullableTokens,
  reasoning_tokens: nullableTokens,
  cache_read_tokens: nullableTokens,
  cache_write_tokens: nullableTokens,
  quality: v.object({
    source: v.union(v.literal("provider"), v.literal("provider-message"), v.literal("lifecycle"), v.literal("legacy")),
    observation_kind: v.optional(v.union(v.literal("cumulative"), v.literal("delta"))),
    provider_observation_id: v.optional(v.string()),
    known_categories: v.array(tokenCategory),
  }),
})

type RevisionFact = {
  host_id?: string
  session_ref: string
  session_id: string
  message_id: string
  stream_id?: string
  run_id?: string
  work_item_id?: string
  revision: number
  observed_at: number
  completed_at?: number
  settlement: "provisional" | "final" | "partial" | "unavailable" | "recovered"
  status: "running" | "completed" | "error" | "stopped" | "interrupted_by_steer" | "process_lost"
  location: "local" | "central" | "cloud-workspace" | "user-hosted"
  harness: string
  provider_id: string
  model_id: string
  workspace_id?: string
  input_tokens: number | null
  output_tokens: number | null
  reasoning_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
  quality: {
    source: "provider" | "provider-message" | "lifecycle" | "legacy"
    observation_kind?: "cumulative" | "delta"
    provider_observation_id?: string
    known_categories: Array<"input" | "output" | "reasoning" | "cache_read" | "cache_write">
  }
}

function assertIdentifier(name: string, value: string, max = 512) {
  if (!value || value.length > max || /[\u0000-\u001f]/.test(value)) throw new Error(`${name} is malformed`)
}

function assertRevision(fact: RevisionFact) {
  if (fact.host_id) assertIdentifier("host_id", fact.host_id, 200)
  assertIdentifier("session_ref", fact.session_ref)
  assertIdentifier("session_id", fact.session_id, 300)
  assertIdentifier("message_id", fact.message_id, 300)
  if (!/^(central:[^:]+|workspace:[^:]+:session:.+)$/.test(fact.session_ref)) {
    throw new Error("session_ref must be a public central or workspace reference")
  }
  if (!Number.isSafeInteger(fact.revision) || fact.revision < 1) throw new Error("revision must be a positive integer")
  for (const [name, value] of Object.entries({
    input_tokens: fact.input_tokens,
    output_tokens: fact.output_tokens,
    reasoning_tokens: fact.reasoning_tokens,
    cache_read_tokens: fact.cache_read_tokens,
    cache_write_tokens: fact.cache_write_tokens,
  })) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`${name} must be a non-negative integer or null`)
    }
  }
  if (!Number.isSafeInteger(fact.observed_at) || fact.observed_at < 0) throw new Error("observed_at must be non-negative")
}

function fingerprint(fact: RevisionFact) {
  return JSON.stringify([
    fact.host_id ?? null, fact.session_ref, fact.session_id, fact.message_id,
    fact.stream_id ?? null, fact.run_id ?? null, fact.work_item_id ?? null, fact.revision,
    fact.observed_at, fact.completed_at ?? null, fact.settlement, fact.status, fact.location,
    fact.harness, fact.provider_id, fact.model_id, fact.workspace_id ?? null,
    fact.input_tokens, fact.output_tokens, fact.reasoning_tokens, fact.cache_read_tokens, fact.cache_write_tokens,
    fact.quality.source, fact.quality.observation_kind ?? null, fact.quality.provider_observation_id ?? null,
    fact.quality.known_categories,
  ])
}

function legacyRevision(row: any): RevisionFact {
  return {
    ...(row.host_id ? { host_id: row.host_id } : {}),
    session_ref: row.session_ref ?? `central:${row.session_id}`,
    session_id: row.session_id,
    message_id: row.message_id,
    ...(row.stream_id ? { stream_id: row.stream_id } : {}),
    ...(row.run_id ? { run_id: row.run_id } : {}),
    ...(row.work_item_id ? { work_item_id: row.work_item_id } : {}),
    revision: row.revision ?? 1,
    observed_at: row.observed_at ?? row.created_at,
    ...(row.completed_at === undefined ? {} : { completed_at: row.completed_at }),
    settlement: row.settlement ?? "final",
    status: row.status ?? (row.turn_status === "error" ? "error" : "completed"),
    location: row.location ?? "central",
    harness: row.harness,
    provider_id: row.provider_id,
    model_id: row.model_id,
    ...(row.workspace_id ? { workspace_id: row.workspace_id } : {}),
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    reasoning_tokens: row.reasoning_tokens,
    cache_read_tokens: row.cache_read_tokens,
    cache_write_tokens: row.cache_write_tokens,
    quality: row.quality ?? {
      source: "legacy",
      known_categories: ["input", "output", "reasoning", "cache_read", "cache_write"],
    },
  }
}

function contribution(fact: RevisionFact, sign: 1 | -1) {
  const count = (value: number | null) => sign * (value ?? 0)
  const known = (value: number | null) => sign * (value === null ? 0 : 1)
  return {
    turn_count: sign,
    input_tokens: count(fact.input_tokens),
    output_tokens: count(fact.output_tokens),
    reasoning_tokens: count(fact.reasoning_tokens),
    cache_read_tokens: count(fact.cache_read_tokens),
    cache_write_tokens: count(fact.cache_write_tokens),
    input_known_count: known(fact.input_tokens),
    output_known_count: known(fact.output_tokens),
    reasoning_known_count: known(fact.reasoning_tokens),
    cache_read_known_count: known(fact.cache_read_tokens),
    cache_write_known_count: known(fact.cache_write_tokens),
    partial_turn_count: sign * (fact.settlement === "partial" ? 1 : 0),
    unavailable_turn_count: sign * (fact.settlement === "unavailable" ? 1 : 0),
    error_turn_count: sign * (fact.status === "error" ? 1 : 0),
  }
}

async function adjustDaily(ctx: { db: any }, identity: { org_id: string; user_id: string }, fact: RevisionFact, sign: 1 | -1, now: number) {
  const date = usageDate(fact.observed_at)
  const existing = await ctx.db.query("llm_usage_daily")
    .withIndex("by_bucket", (q: any) => q.eq("org_id", identity.org_id).eq("user_id", identity.user_id).eq("date", date))
    .unique()
  const delta = contribution(fact, sign)
  if (!existing) {
    if (sign < 0) return
    await ctx.db.insert("llm_usage_daily", {
      ...identity,
      date,
      ...delta,
      created_at: now,
      updated_at: now,
    })
    return
  }
  const next = Object.fromEntries(Object.keys(delta).map((name) => [name, existing[name] + delta[name as keyof typeof delta]]))
  if (next.turn_count === 0) await ctx.db.delete(existing._id)
  else await ctx.db.patch(existing._id, { ...next, updated_at: now })
}

const breakdownDimensions = ["harness", "model", "location", "session", "workspace"] as const
type BreakdownDimension = (typeof breakdownDimensions)[number]

function breakdownValue(fact: RevisionFact, dimension: BreakdownDimension) {
  if (dimension === "harness") return fact.harness
  if (dimension === "model") return `${fact.provider_id}/${fact.model_id}`
  if (dimension === "location") return fact.location
  if (dimension === "session") return fact.session_ref
  return fact.workspace_id ?? "unavailable"
}

async function adjustBreakdowns(
  ctx: { db: any },
  identity: { org_id: string; user_id: string },
  fact: RevisionFact,
  sign: 1 | -1,
  now: number,
) {
  const date = usageDate(fact.observed_at)
  const tokenValues = [fact.input_tokens, fact.output_tokens, fact.reasoning_tokens, fact.cache_read_tokens, fact.cache_write_tokens]
  const delta = {
    turn_count: sign,
    input_tokens: sign * (fact.input_tokens ?? 0),
    output_tokens: sign * (fact.output_tokens ?? 0),
    reasoning_tokens: sign * (fact.reasoning_tokens ?? 0),
    cache_read_tokens: sign * (fact.cache_read_tokens ?? 0),
    cache_write_tokens: sign * (fact.cache_write_tokens ?? 0),
    known_token_count: sign * tokenValues.filter((value) => value !== null).length,
    unknown_token_count: sign * tokenValues.filter((value) => value === null).length,
  }
  for (const dimension of breakdownDimensions) {
    const value = breakdownValue(fact, dimension)
    const existing = await ctx.db.query("llm_usage_breakdown_daily")
      .withIndex("by_bucket", (q: any) => q
        .eq("org_id", identity.org_id).eq("user_id", identity.user_id)
        .eq("date", date).eq("dimension", dimension).eq("value", value))
      .unique()
    if (!existing) {
      if (sign < 0) continue
      await ctx.db.insert("llm_usage_breakdown_daily", {
        ...identity, date, dimension, value, ...delta, created_at: now, updated_at: now,
      })
      continue
    }
    const next = Object.fromEntries(Object.keys(delta).map((name) => [name, existing[name] + delta[name as keyof typeof delta]]))
    if (next.turn_count === 0) await ctx.db.delete(existing._id)
    else await ctx.db.patch(existing._id, { ...next, updated_at: now })
  }
}

async function activate(ctx: { db: any }, userId: string, fact: RevisionFact, now: number) {
  if (fact.status !== "completed" || (fact.settlement !== "final" && fact.settlement !== "recovered")) return false
  const user = await userByClerkSubject(ctx.db, userId)
  if (!user || typeof user.first_activated_at === "number") return false
  await ctx.db.patch(user._id, { first_activated_at: now, updated_at: now })
  return true
}

export async function recordTurnUsageRevision(
  ctx: { db: any },
  identity: { org_id: string; user_id: string },
  fact: RevisionFact,
  now: number,
) {
  assertRevision(fact)
  const hash = fingerprint(fact)
  let existing = await ctx.db.query("llm_usage_events")
    .withIndex("by_org_session_ref_message", (q: any) =>
      q.eq("org_id", identity.org_id).eq("session_ref", fact.session_ref).eq("message_id", fact.message_id))
    .unique()
  // Expand/backfill compatibility: a pre-revision writer had no session_ref.
  // The org/message index is still tenant-bounded and message ids are stable;
  // checking session_id prevents a guessed id from claiming another turn.
  if (!existing) {
    existing = (await ctx.db.query("llm_usage_events")
      .withIndex("by_org_message", (q: any) => q.eq("org_id", identity.org_id).eq("message_id", fact.message_id))
      .collect())
      .find((row: any) => row.session_ref === undefined && row.session_id === fact.session_id)
  }
  if (existing) {
    const current = legacyRevision(existing)
    if (fact.revision < current.revision) {
      return { id: existing._id, status: "stale" as const, revision: fact.revision, current_revision: current.revision, activated: false }
    }
    if (fact.revision === current.revision) {
      const same = (existing.payload_hash ?? fingerprint(current)) === hash
      return {
        id: existing._id,
        status: same ? "duplicate" as const : "conflict" as const,
        revision: fact.revision,
        current_revision: current.revision,
        activated: false,
      }
    }
    if (existing.usage_rolled_up_at !== undefined) {
      await adjustDaily(ctx, identity, current, -1, now)
      await adjustBreakdowns(ctx, identity, current, -1, now)
    }
    await adjustDaily(ctx, identity, fact, 1, now)
    await adjustBreakdowns(ctx, identity, fact, 1, now)
    await ctx.db.patch(existing._id, {
      ...fact,
      ...identity,
      payload_hash: hash,
      turn_status: fact.status === "error" ? "error" : "ok",
      latency_ms: Math.max(0, (fact.completed_at ?? fact.observed_at) - fact.observed_at),
      usage_rolled_up_at: now,
      updated_at: now,
    })
    await ctx.db.insert("llm_usage_revisions", { ...identity, ...fact, payload_hash: hash, created_at: now })
    return {
      id: existing._id,
      status: "accepted" as const,
      revision: fact.revision,
      activated: await activate(ctx, identity.user_id, fact, now),
    }
  }
  await adjustDaily(ctx, identity, fact, 1, now)
  await adjustBreakdowns(ctx, identity, fact, 1, now)
  const id = await ctx.db.insert("llm_usage_events", {
    ...identity,
    ...fact,
    payload_hash: hash,
    turn_status: fact.status === "error" ? "error" : "ok",
    latency_ms: Math.max(0, (fact.completed_at ?? fact.observed_at) - fact.observed_at),
    usage_rolled_up_at: now,
    created_at: now,
    updated_at: now,
  })
  await ctx.db.insert("llm_usage_revisions", { ...identity, ...fact, payload_hash: hash, created_at: now })
  return {
    id,
    status: "accepted" as const,
    revision: fact.revision,
    activated: await activate(ctx, identity.user_id, fact, now),
  }
}

export const ingestTurnUsageBatch = serviceMutation({
  args: {
    org_id: v.string(),
    user_id: v.string(),
    revisions: v.array(turnUsageRevision),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (args.revisions.length > 100) throw new Error("usage ingest accepts at most 100 revisions")
    for (const fact of args.revisions) assertRevision(fact as RevisionFact)
    const now = args.now ?? Date.now()
    const results = []
    for (const fact of args.revisions) {
      results.push(await recordTurnUsageRevision(ctx, { org_id: args.org_id, user_id: args.user_id }, fact as RevisionFact, now))
    }
    return { results }
  },
})

export const usageDashboard = serviceQuery({
  args: {
    org_id: v.string(),
    user_id: v.optional(v.string()),
    since: v.number(),
    until: v.number(),
  },
  handler: async (ctx, args) => {
    if (args.until < args.since) throw new Error("until must not precede since")
    if (!Number.isFinite(args.since) || !Number.isFinite(args.until)) throw new Error("usage range must be finite")
    if (args.until - args.since > MAX_DASHBOARD_RANGE_MS) throw new Error("usage range must not exceed 90 days")
    const from = usageDate(Math.max(-8_640_000_000_000_000, args.since))
    const to = usageDate(Math.min(8_640_000_000_000_000, args.until))
    const rows = args.user_id
      ? await ctx.db.query("llm_usage_daily")
        .withIndex("by_org_user_date", (q: any) =>
          q.eq("org_id", args.org_id).eq("user_id", args.user_id).gte("date", from).lte("date", to))
        .take(400)
      : await ctx.db.query("llm_usage_daily")
        .withIndex("by_org_date", (q: any) => q.eq("org_id", args.org_id).gte("date", from).lte("date", to))
        .take(5_000)
    const fields = [
      "turn_count", "input_tokens", "output_tokens", "reasoning_tokens", "cache_read_tokens", "cache_write_tokens",
      "input_known_count", "output_known_count", "reasoning_known_count", "cache_read_known_count", "cache_write_known_count",
      "partial_turn_count", "unavailable_turn_count", "error_turn_count",
    ] as const
    const totals = Object.fromEntries(fields.map((field) => [field, rows.reduce((sum, row) => sum + row[field], 0)]))
    const daily = new Map<string, typeof rows>()
    for (const row of rows) daily.set(row.date, [...(daily.get(row.date) ?? []), row])
    return {
      totals,
      daily: [...daily.entries()].map(([date, items]) => ({
        date,
        ...Object.fromEntries(fields.map((field) => [field, items.reduce((sum, row) => sum + row[field], 0)])),
      })).toSorted((a, b) => a.date.localeCompare(b.date)),
    }
  },
})

/**
 * Exact, timezone-aware dashboard projection page. The server folds these
 * compact pages across transactions, so a dense 90-day range is complete
 * without asking one Convex query to read an unbounded fact set.
 */
export const usageDashboardPage = serviceQuery({
  args: {
    org_id: v.string(),
    user_id: v.string(),
    since: v.number(),
    until: v.number(),
    time_zone: v.string(),
    dimension: v.optional(v.union(
      v.literal("harness"), v.literal("model"), v.literal("location"),
      v.literal("session"), v.literal("workspace"),
    )),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.until < args.since || !Number.isFinite(args.since) || !Number.isFinite(args.until)) {
      throw new Error("usage range is invalid")
    }
    if (args.until - args.since > MAX_DASHBOARD_RANGE_MS) throw new Error("usage range must not exceed 90 days")
    let formatDate: Intl.DateTimeFormat
    try {
      formatDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: args.time_zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
    } catch {
      throw new Error("usage timezone is invalid")
    }
    const result = await ctx.db.query("llm_usage_events")
      .withIndex("by_org_user_observed", (q: any) => q
        .eq("org_id", args.org_id).eq("user_id", args.user_id)
        .gte("observed_at", args.since).lte("observed_at", args.until))
      .paginate({ cursor: args.cursor ?? null, numItems: 2_000 })
    const fields = [
      "turn_count", "input_tokens", "output_tokens", "reasoning_tokens", "cache_read_tokens", "cache_write_tokens",
      "input_known_count", "output_known_count", "reasoning_known_count", "cache_read_known_count", "cache_write_known_count",
      "partial_turn_count", "unavailable_turn_count", "error_turn_count",
    ] as const
    const empty = () => Object.fromEntries(fields.map((field) => [field, 0])) as Record<(typeof fields)[number], number>
    const add = (target: Record<string, number>, delta: Record<string, number>) => {
      for (const field of fields) target[field] = (target[field] ?? 0) + (delta[field] ?? 0)
    }
    const totals = empty()
    const daily = new Map<string, ReturnType<typeof empty>>()
    const models = new Map<string, ReturnType<typeof empty>>()
    const breakdown = new Map<string, ReturnType<typeof empty>>()
    for (const row of result.page) {
      const fact = legacyRevision(row)
      const delta = contribution(fact, 1)
      add(totals, delta)
      const date = formatDate.format(new Date(fact.observed_at))
      const day = daily.get(date) ?? empty()
      add(day, delta)
      daily.set(date, day)
      const model = models.get(`${fact.provider_id}/${fact.model_id}`) ?? empty()
      add(model, delta)
      models.set(`${fact.provider_id}/${fact.model_id}`, model)
      if (args.dimension) {
        const value = breakdownValue(fact, args.dimension)
        const grouped = breakdown.get(value) ?? empty()
        add(grouped, delta)
        breakdown.set(value, grouped)
      }
    }
    const rows = (source: Map<string, ReturnType<typeof empty>>) => [...source]
      .map(([value, values]) => ({ value, ...values }))
      .toSorted((a, b) => a.value.localeCompare(b.value))
    const groupedRows = (source: Map<string, ReturnType<typeof empty>>) => rows(source).map((row) => {
      const known_token_count = row.input_known_count + row.output_known_count + row.reasoning_known_count
        + row.cache_read_known_count + row.cache_write_known_count
      return { ...row, known_token_count, unknown_token_count: row.turn_count * 5 - known_token_count }
    })
    return {
      totals,
      daily: [...daily]
        .map(([date, values]) => ({ date, ...values }))
        .toSorted((a, b) => a.date.localeCompare(b.date)),
      models: groupedRows(models),
      breakdown: groupedRows(breakdown),
      next: result.isDone ? undefined : result.continueCursor,
    }
  },
})

export const usageBreakdown = serviceQuery({
  args: {
    org_id: v.string(),
    user_id: v.string(),
    since: v.number(),
    until: v.number(),
    dimension: v.union(
      v.literal("harness"), v.literal("model"), v.literal("location"),
      v.literal("session"), v.literal("workspace"),
    ),
    after: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (args.until < args.since || !Number.isFinite(args.since) || !Number.isFinite(args.until)) {
      throw new Error("usage range is invalid")
    }
    if (args.until - args.since > MAX_DASHBOARD_RANGE_MS) throw new Error("usage range must not exceed 90 days")
    const limit = args.limit ?? 50
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be between 1 and 100")
    const from = usageDate(args.since)
    const to = usageDate(args.until)
    const source = await ctx.db.query("llm_usage_breakdown_daily")
      .withIndex("by_org_user_dimension_value_date", (q: any) => q
        .eq("org_id", args.org_id).eq("user_id", args.user_id).eq("dimension", args.dimension))
      .filter((q: any) => q.and(
        args.after ? q.gt(q.field("value"), args.after) : q.gte(q.field("value"), ""),
        q.gte(q.field("date"), from),
        q.lte(q.field("date"), to),
      ))
      .take(5000)
    const fields = ["turn_count", "input_tokens", "output_tokens", "reasoning_tokens", "cache_read_tokens", "cache_write_tokens", "known_token_count", "unknown_token_count"] as const
    const grouped = new Map<string, Record<string, number>>()
    for (const row of source) {
      const item = grouped.get(row.value) ?? Object.fromEntries(fields.map((field) => [field, 0]))
      for (const field of fields) item[field] += row[field]
      grouped.set(row.value, item)
    }
    const rows = [...grouped.entries()]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .slice(0, limit + 1)
    const hasMore = rows.length > limit
    const page = rows.slice(0, limit).map(([value, totals]) => ({ value, ...totals }))
    return { rows: page, next: hasMore ? page.at(-1)?.value : undefined }
  },
})

export const resolveWorkGraphAttribution = serviceQuery({
  args: {
    org_id: v.string(),
    user_id: v.string(),
    session_id: v.string(),
  },
  handler: async (ctx, args) => {
    const [organization, owner] = await Promise.all([
      orgByClerkOrgId(ctx.db, args.org_id),
      userByClerkSubject(ctx.db, args.user_id),
    ])
    if (!organization || !owner) return
    const membership = await ctx.db.query("org_memberships")
      .withIndex("by_org_user", (query: any) => query.eq("org_id", organization._id).eq("user_id", owner._id))
      .unique()
    if (!membership) return
    if (args.session_id.startsWith(RUN_SESSION_PREFIX)) {
      const runId = args.session_id.slice(RUN_SESSION_PREFIX.length)
      const run = await ctx.db.query("workgraph_runs")
        .withIndex("by_tenant_id", (query: any) =>
          query.eq("organization_id", organization._id).eq("owner_user_id", owner._id).eq("id", runId))
        .unique()
      if (!run) return
      return { stream_id: run.stream_id, run_id: run.id, work_item_id: run.work_item_id }
    }
    if (args.session_id.startsWith(MASTER_SESSION_PREFIX)) {
      const streamId = args.session_id.slice(MASTER_SESSION_PREFIX.length)
      const stream = await ctx.db.query("workgraph_streams")
        .withIndex("by_tenant_id", (query: any) =>
          query.eq("organization_id", organization._id).eq("owner_user_id", owner._id).eq("id", streamId))
        .unique()
      return stream ? { stream_id: stream.id } : undefined
    }
    if (!args.session_id.startsWith(sourcePlanningSessionPrefix)) return
    const identity = args.session_id.slice(sourcePlanningSessionPrefix.length)
    const separator = identity.lastIndexOf("_")
    if (separator <= 0 || !/^\d+$/.test(identity.slice(separator + 1))) return
    const proposal = await ctx.db.query("workgraph_admission_proposals")
      .withIndex("by_tenant_id", (query: any) =>
        query
          .eq("organization_id", organization._id)
          .eq("owner_user_id", owner._id)
          .eq("id", identity.slice(0, separator)))
      .unique()
    const streamId = proposal?.planning_evidence?.targetStreamId
    return typeof streamId === "string" ? { stream_id: streamId } : undefined
  },
})

// ---------------------------------------------------------------------------
// AI tokens (metric spec §4.3) + activation (§4.5)
// ---------------------------------------------------------------------------

/**
 * Record one completed model turn, and stamp activation if this is the user's
 * first successful one.
 *
 * Activation lives HERE, in the same transaction as the fact that triggers it,
 * rather than as a follow-up write from the server: a check-and-set split
 * across two round-trips can fire twice under concurrent turns, and
 * "user_activated" firing twice for one user is a silently wrong funnel rather
 * than a visible failure. `activated` in the result is the server's signal to
 * emit the product-plane event exactly once.
 */
export const recordLlmTurn = serviceMutation({
  args: {
    org_id: v.string(),
    user_id: v.string(),
    message_id: v.string(),
    session_id: v.string(),
    stream_id: v.optional(v.string()),
    run_id: v.optional(v.string()),
    work_item_id: v.optional(v.string()),
    harness: v.string(),
    provider_id: v.string(),
    model_id: v.string(),
    input_tokens: v.number(),
    output_tokens: v.number(),
    reasoning_tokens: v.number(),
    cache_read_tokens: v.number(),
    cache_write_tokens: v.number(),
    turn_status: turnStatus,
    latency_ms: v.number(),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now()
    const { service_token: _service_token, now: _now, ...fact } = args
    return await recordLlmTurnFact(ctx, fact, now)
  },
})

/**
 * The shared write: dedupe on (org, session, message), insert the fact, stamp
 * activation on the user's first ok turn. Shared between the signed
 * `recordLlmTurn` boundary above and the WorkGraph transcript syncs in
 * `sessions.ts`, which observe hosted sandbox turns that never traverse the
 * central session runtime.
 */
export async function recordLlmTurnFact(
  ctx: { db: any },
  fact: {
    org_id: string
    user_id: string
    message_id: string
    session_id: string
    stream_id?: string
    run_id?: string
    work_item_id?: string
    harness: string
    provider_id: string
    model_id: string
    input_tokens: number | null
    output_tokens: number | null
    reasoning_tokens: number | null
    cache_read_tokens: number | null
    cache_write_tokens: number | null
    turn_status: "ok" | "error"
    latency_ms: number
    session_ref?: string
    host_id?: string
    workspace_id?: string
    location?: "local" | "central" | "cloud-workspace" | "user-hosted"
    revision?: number
  },
  now: number,
) {
  const known = (value: number | null) => value === null ? [] : [value]
  const categories = [
    ...known(fact.input_tokens).map(() => "input" as const),
    ...known(fact.output_tokens).map(() => "output" as const),
    ...known(fact.reasoning_tokens).map(() => "reasoning" as const),
    ...known(fact.cache_read_tokens).map(() => "cache_read" as const),
    ...known(fact.cache_write_tokens).map(() => "cache_write" as const),
  ]
  const result = await recordTurnUsageRevision(ctx, { org_id: fact.org_id, user_id: fact.user_id }, {
    ...(fact.host_id ? { host_id: fact.host_id } : {}),
    session_ref: fact.session_ref ?? `central:${fact.session_id}`,
    session_id: fact.session_id,
    message_id: fact.message_id,
    ...(fact.stream_id ? { stream_id: fact.stream_id } : {}),
    ...(fact.run_id ? { run_id: fact.run_id } : {}),
    ...(fact.work_item_id ? { work_item_id: fact.work_item_id } : {}),
    revision: fact.revision ?? 1,
    observed_at: Math.max(0, now - fact.latency_ms),
    completed_at: now,
    settlement: "final",
    status: fact.turn_status === "error" ? "error" : "completed",
    location: fact.location ?? "central",
    harness: fact.harness,
    provider_id: fact.provider_id,
    model_id: fact.model_id,
    ...(fact.workspace_id ? { workspace_id: fact.workspace_id } : {}),
    input_tokens: fact.input_tokens,
    output_tokens: fact.output_tokens,
    reasoning_tokens: fact.reasoning_tokens,
    cache_read_tokens: fact.cache_read_tokens,
    cache_write_tokens: fact.cache_write_tokens,
    quality: { source: "legacy", known_categories: categories },
  }, now)
  // Preserve the legacy reader contract while all callers migrate to observed/completed timestamps.
  await ctx.db.patch(result.id, { latency_ms: fact.latency_ms })
  return { id: result.id, activated: result.activated }
}

/** Reader: the staging DoD's "query `llm_usage_events` by `session_id`". */
export const llmUsageForSession = serviceQuery({
  args: { session_id: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("llm_usage_events")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
      .collect()
  },
})

/**
 * Reader: "how many AI tokens does my average user consume?" — totals plus the
 * distinct-user count the average divides by, so the answer never depends on a
 * second query agreeing about the denominator.
 */
export const llmUsageTotals = serviceQuery({
  args: {
    org_id: v.optional(v.string()),
    since: v.optional(v.number()),
    until: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const since = args.since ?? 0
    const until = args.until ?? Number.MAX_SAFE_INTEGER
    const rows = (await ctx.db
      .query("llm_usage_events")
      .withIndex("by_created_at", (q) => q.gte("created_at", since).lte("created_at", until))
      .collect())
      .filter((row) => !args.org_id || row.org_id === args.org_id)
    const users = new Set(rows.map((row) => row.user_id))
    const total = (pick: (row: (typeof rows)[number]) => number | null) => rows.reduce((sum, row) => sum + (pick(row) ?? 0), 0)
    const inputTokens = total((row) => row.input_tokens)
    const outputTokens = total((row) => row.output_tokens)
    const reasoningTokens = total((row) => row.reasoning_tokens)
    return {
      turn_count: rows.length,
      user_count: users.size,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      reasoning_tokens: reasoningTokens,
      cache_read_tokens: total((row) => row.cache_read_tokens),
      cache_write_tokens: total((row) => row.cache_write_tokens),
      error_turn_count: rows.filter((row) => row.turn_status === "error").length,
      billable_tokens_per_user: users.size
        ? (inputTokens + outputTokens + reasoningTokens) / users.size
        : 0,
    }
  },
})

// ---------------------------------------------------------------------------
// Sandbox compute (metric spec §4.2)
// ---------------------------------------------------------------------------

/**
 * Reader: the staging DoD's "query the table for that `sandbox_id` and confirm
 * `active_ms` matches wall-clock" — the check that distinguishes a real
 * measurement from "the emit function was called".
 */
export const leaseEventsForSandbox = serviceQuery({
  args: { sandbox_id: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("sandbox_lease_events")
      .withIndex("by_sandbox_id", (q) => q.eq("sandbox_id", args.sandbox_id))
      .collect()
  },
})

/** Reader: the rollup itself — `AVG(total_active_seconds) GROUP BY date`. */
export const sandboxUsageDaily = serviceQuery({
  args: {
    org_id: v.optional(v.string()),
    from_date: v.optional(v.string()),
    to_date: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // W5: pick the index the arguments actually support.
    //
    // Scoped to one org, `by_org_date` carries the date window as a range on
    // its second field — the common case, and the only one whose read-set is
    // bounded by a tenant. Unscoped, `by_date` still bounds the read to the
    // requested window; a caller asking for every org with no dates gets the
    // most recent `USAGE_ROLLUP_ROW_LIMIT` rows rather than a thrown query.
    const dateWindow = (q: any) => {
      let range = q
      if (args.from_date) range = range.gte("date", args.from_date)
      if (args.to_date) range = range.lte("date", args.to_date)
      return range
    }
    const rows = (args.org_id
      ? await ctx.db.query("sandbox_usage_daily")
        .withIndex("by_org_date", (q: any) => dateWindow(q.eq("org_id", args.org_id)))
        .take(USAGE_ROLLUP_ROW_LIMIT)
      : await ctx.db.query("sandbox_usage_daily")
        .withIndex("by_date", (q: any) => dateWindow(q))
        .take(USAGE_ROLLUP_ROW_LIMIT))
      .toSorted((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    const users = new Set(rows.map((row) => row.user_id))
    const totalActiveSeconds = rows.reduce((sum, row) => sum + row.total_active_seconds, 0)
    return {
      rows,
      total_active_seconds: totalActiveSeconds,
      lease_count: rows.reduce((sum, row) => sum + row.lease_count, 0),
      user_count: users.size,
      active_seconds_per_user: users.size ? totalActiveSeconds / users.size : 0,
    }
  },
})

/**
 * Roll closed lease intervals into the daily table.
 *
 * Each fact is consumed exactly once: the sweep only reads rows with no
 * `rolled_up_at` and stamps them as it goes, so a re-run — or a run that
 * overlaps the previous one — adds nothing a second time. That is why the
 * rollup accumulates onto the bucket instead of recomputing it.
 */
export const rollupSandboxUsageDaily = cronMutation({
  args: {
    limit: v.optional(v.number()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now()
    // W5: the pending queue as an index range. `.eq(…, undefined)` is Convex's
    // "field absent" match, which is exactly the unconsumed set — and because
    // the loop below stamps `rolled_up_at`, consumed facts leave the range
    // rather than being re-read forever. `.take()` applies the batch limit at
    // the database instead of slicing after reading the whole table, so the
    // read-set is the batch.
    const pending = await ctx.db.query("sandbox_lease_events")
      .withIndex("by_rolled_up_at", (q: any) => q.eq("rolled_up_at", undefined))
      .take(args.limit ?? 1000)
    let bucketsWritten = 0
    for (const fact of pending) {
      // Narrowed by date on the index, then matched on the rest in JS: one
      // day's buckets are a small set, and the generic (untyped) db handle the
      // component builders expose does not carry the compound-index shape.
      const bucket = (await ctx.db
        .query("sandbox_usage_daily")
        .withIndex("by_date", (q) => q.eq("date", fact.date))
        .collect())
        .find((row) =>
          row.org_id === fact.org_id
          && row.user_id === fact.user_id
          && row.driver === fact.driver)
      // Seconds, not milliseconds: the rollup is the money-facing unit and
      // `total_active_seconds` is what the owner's question is phrased in.
      const seconds = fact.active_ms / 1000
      if (bucket) {
        await ctx.db.patch(bucket._id, {
          total_active_seconds: bucket.total_active_seconds + seconds,
          lease_count: bucket.lease_count + 1,
          updated_at: now,
        })
      } else {
        await ctx.db.insert("sandbox_usage_daily", {
          org_id: fact.org_id,
          user_id: fact.user_id,
          date: fact.date,
          driver: fact.driver,
          total_active_seconds: seconds,
          lease_count: 1,
          created_at: now,
          updated_at: now,
        })
        bucketsWritten += 1
      }
      await ctx.db.patch(fact._id, { rolled_up_at: now })
    }
    return { rolled_up: pending.length, buckets_created: bucketsWritten }
  },
})

// ---------------------------------------------------------------------------
// Retention (plan D3)
// ---------------------------------------------------------------------------

/** Expand/backfill legacy completed rows before retention or new readers rely on projections. */
export const backfillLegacyLlmUsage = cronMutation({
  args: { limit: v.optional(v.number()), now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now()
    const pending = await ctx.db.query("llm_usage_events")
      .withIndex("by_usage_rolled_up_at", (q: any) => q.eq("usage_rolled_up_at", undefined))
      .take(args.limit ?? 100)
    for (const row of pending) {
      const fact = legacyRevision(row)
      assertRevision(fact)
      const identity = { org_id: row.org_id, user_id: row.user_id }
      const hash = fingerprint(fact)
      await adjustDaily(ctx, identity, fact, 1, now)
      await adjustBreakdowns(ctx, identity, fact, 1, now)
      await ctx.db.patch(row._id, {
        ...fact,
        payload_hash: hash,
        usage_rolled_up_at: now,
        updated_at: now,
      })
      const revision = await ctx.db.query("llm_usage_revisions")
        .withIndex("by_turn_revision", (q: any) => q
          .eq("org_id", row.org_id).eq("session_ref", fact.session_ref)
          .eq("message_id", fact.message_id).eq("revision", fact.revision))
        .unique()
      if (!revision) await ctx.db.insert("llm_usage_revisions", { ...identity, ...fact, payload_hash: hash, created_at: now })
    }
    return { backfilled: pending.length }
  },
})

/**
 * Prune raw fact rows past the retention window; rollups are kept.
 *
 * One row per lease and per turn is unbounded growth at Cloud scale, and
 * `audit_events` shipping with no retention cron is exactly the shape this
 * avoids. A fact is only prunable once it has been rolled up, so pruning can
 * never erase compute the daily table has not yet counted.
 */
export const pruneUsageFacts = cronMutation({
  args: {
    retain_ms: v.number(),
    limit: v.optional(v.number()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now()
    const cutoff = now - args.retain_ms
    const limit = args.limit ?? 1000

    const leaseFacts = (await ctx.db
      .query("sandbox_lease_events")
      .withIndex("by_created_at", (q) => q.lt("created_at", cutoff))
      .collect())
      .filter((row) => row.rolled_up_at !== undefined)
      .slice(0, limit)
    for (const row of leaseFacts) await ctx.db.delete(row._id)

    const turnFacts = (await ctx.db
      .query("llm_usage_events")
      .withIndex("by_created_at", (q) => q.lt("created_at", cutoff))
      .collect())
      .filter((row) => row.usage_rolled_up_at !== undefined)
      .slice(0, limit)
    for (const row of turnFacts) await ctx.db.delete(row._id)

    const revisions = (await ctx.db
      .query("llm_usage_revisions")
      .withIndex("by_created_at", (q) => q.lt("created_at", cutoff))
      .take(limit))
    for (const row of revisions) await ctx.db.delete(row._id)

    return {
      cutoff,
      lease_events_deleted: leaseFacts.length,
      llm_usage_events_deleted: turnFacts.length,
      llm_usage_revisions_deleted: revisions.length,
    }
  },
})

// Re-exported so the metering surface has one import site; the canonical
// definition stays beside the close path that stamps it.
export { usageDate }
