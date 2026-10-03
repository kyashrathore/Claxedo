import { matchesSessionActivity, sessionAttention, type SessionActivityFilter, type SessionAttentionFacts, type SessionReaderState } from "@claxedo/agent-runtime-contract"
import { ClaxedoError } from "../platform/errors/base"

export type SessionReaderFilter = {
  activity?: SessionActivityFilter
  ownership?: "all" | "shared"
  settled?: "active" | "settled" | "all"
  seen?: "seen" | "unseen" | "all"
  dateField?: "created" | "activity" | "settled"
  from?: number
  until?: number
}

function invalid(): never { throw new ClaxedoError({ code: "invalid_session_list_query", message: "Invalid session reader filter", status: 400 }) }

export function parseSessionReaderFilter(params: URLSearchParams): SessionReaderFilter {
  const activity = params.get("activity") ?? undefined
  if (activity !== undefined && activity !== "all" && activity !== "working" && activity !== "needs-you") invalid()
  const settled = params.get("settled") ?? "active"
  const ownership = params.get("ownership") ?? "all"
  const seen = params.get("seen") ?? "all"
  const dateField = params.get("dateField") ?? undefined
  if (settled !== "active" && settled !== "settled" && settled !== "all") invalid()
  if (ownership !== "all" && ownership !== "shared") invalid()
  if (seen !== "seen" && seen !== "unseen" && seen !== "all") invalid()
  if (dateField !== undefined && dateField !== "created" && dateField !== "activity" && dateField !== "settled") invalid()
  const from = dateBound(params.get("from"))
  const until = dateBound(params.get("until"))
  if ((from !== undefined || until !== undefined) && !dateField) invalid()
  if (from !== undefined && until !== undefined && from >= until) invalid()
  return { ...(activity ? { activity } : {}), ownership, settled, seen, dateField, from, until }
}


function dateBound(value: string | null) {
  if (value === null) return undefined
  const fields = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d)(?:\.\d{1,3})?)?(?:Z|([+-])(\d\d):(\d\d))$/.exec(value)
  if (!fields) invalid()
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = fields
  const daysInMonth = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate()
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > daysInMonth
    || Number(hour) > 23 || Number(minute) > 59 || Number(second ?? 0) > 59
    || Number(offsetHour ?? 0) > 23 || Number(offsetMinute ?? 0) > 59) invalid()
  const parsed = Date.parse(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) invalid()
  return parsed
}

export function matchesSessionReader(row: { createdAt: number; attention?: SessionAttentionFacts; reader?: SessionReaderState; ownership?: "owned" | "shared" }, query: SessionReaderFilter) {
  if (query.ownership === "shared" && row.ownership !== "shared") return false
  if (!matchesSessionActivity(row.attention, query.activity ?? "all")) return false
  const state = row.attention ? sessionAttention(row.attention, row.reader) : undefined
  if (query.settled === "settled" ? !state?.settled : query.settled !== "all" && state?.settled) return false
  if (query.seen === "unseen" && !state?.unseen) return false
  if (query.seen === "seen" && (!state || state.unseen)) return false
  const date = query.dateField === "activity" ? row.attention?.activityAt
    : query.dateField === "settled" ? (state?.settled ? row.reader?.settledAt : undefined) : row.createdAt
  if (query.from !== undefined && (date === undefined || date < query.from)) return false
  if (query.until !== undefined && (date === undefined || date >= query.until)) return false
  return true
}

export function sessionReaderSql(columns: { facts: string; reader: string; created: string }, query: SessionReaderFilter) {
  const f = (key: string) => `json_extract(${columns.facts}, '$.${key}')`
  const r = (key: string) => `json_extract(${columns.reader}, '$.${key}')`
  const current = `(${r("generation")} = ${f("generation")})`
  const seen = `CASE WHEN ${current} THEN coalesce(${r("seenThrough")}, 0) ELSE 0 END`
  const unseen = `coalesce((${f("outcome.status")} <> 'cancelled' AND ${f("outcome.sequence")} > ${seen}), 0)`
  const settled = `coalesce((${current} AND ${r("settledThrough")} = ${f("activitySequence")} AND ${f("working")} = 0 AND ${f("awaitingInput")} = 0), 0)`
  const working = `coalesce((${f("working")} = 1 AND ${f("awaitingInput")} = 0), 0)`
  const where: string[] = []
  const params: Array<string | number> = []
  if (query.activity && query.activity !== "all") where.push(`${working} = ${query.activity === "working" ? 1 : 0}`)
  if (query.settled !== "all") where.push(`${settled} = ${query.settled === "settled" ? 1 : 0}`)
  if (query.seen === "unseen") where.push(`${unseen} = 1`)
  if (query.seen === "seen") where.push(`${columns.facts} IS NOT NULL AND ${unseen} = 0`)
  const date = query.dateField === "activity" ? f("activityAt")
    : query.dateField === "settled" ? `CASE WHEN ${settled} THEN ${r("settledAt")} END` : columns.created
  if (query.from !== undefined) { where.push(`${date} >= ?`); params.push(query.from) }
  if (query.until !== undefined) { where.push(`${date} < ?`); params.push(query.until) }
  return { where, params }
}
