import { asRecord, readField } from "@/lib/record"
import type { AgentRuntimeStatus as SessionStatus } from "@claxedo/agent-runtime-contract"
import { queryClient } from "@/platform/query/query-client"

// The gate is a sliding window, not a monotonic one: a session that once had
// a disagreement is not locked out of polling removal forever. It opens once
// there has been no disagreement in the recent `T_RECOVER_MS` window and at
// least `N_MATCHES_REQUIRED` matching polls inside the recent `T_WINDOW_MS`
// window. The constants are deliberate and live in the file header so an
// operator can tune them without grepping.
const T_RECOVER_MS = 10 * 60 * 1000 // 10 minutes after the last disagreement
const T_WINDOW_MS = 30 * 60 * 1000 // matching polls evaluated over the last 30 min
const N_MATCHES_REQUIRED = 3 // need 3 matching polls in the window

export function waitForActiveStatusPollDelay(delay: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, delay)
    signal?.addEventListener("abort", () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })
}

type StatusSnapshot = {
  directory?: string
  sessionID: string
  status?: SessionStatus
  at: number
}

export type SessionStatusPollDisagreement = {
  directory?: string
  sessionID: string
  eventStatus?: SessionStatus
  polledStatus?: SessionStatus
  count: number
  firstSeenAt: number
  lastSeenAt: number
}

type MatchingPollBucket = { entries: StatusSnapshot[]; total: number }
type TelemetryKind = "event" | "matches" | "disagreement"

export function sessionStatusTelemetryQueryKey(kind: TelemetryKind, sessionID: string) {
  return ["shell", "session-status-telemetry", kind, statusKey(sessionID)] as const
}

function telemetryPrefix(kind?: TelemetryKind) {
  return kind ? ["shell", "session-status-telemetry", kind] as const : ["shell", "session-status-telemetry"] as const
}

function statusKey(sessionID: string) {
  return sessionID
}

function statusFingerprint(status: SessionStatus | undefined) {
  return JSON.stringify(status ?? null)
}

function trimSnapshots(entries: StatusSnapshot[], now: number) {
  // Keep only entries within the rolling window. Mutates the array in place.
  while (entries.length > 0 && now - entries[0].at > T_WINDOW_MS) entries.shift()
}

function eventSnapshot(key: string) {
  return queryClient.getQueryData<StatusSnapshot>(sessionStatusTelemetryQueryKey("event", key))
}

function setEventSnapshot(key: string, value: StatusSnapshot) {
  queryClient.setQueryData(sessionStatusTelemetryQueryKey("event", key), value)
}

function matchingPollBucket(key: string) {
  return queryClient.getQueryData<MatchingPollBucket>(sessionStatusTelemetryQueryKey("matches", key))
}

function setMatchingPollBucket(key: string, value: MatchingPollBucket) {
  queryClient.setQueryData(sessionStatusTelemetryQueryKey("matches", key), value)
}

function pollDisagreement(key: string) {
  return queryClient.getQueryData<SessionStatusPollDisagreement>(sessionStatusTelemetryQueryKey("disagreement", key))
}

function setPollDisagreement(key: string, value: SessionStatusPollDisagreement) {
  queryClient.setQueryData(sessionStatusTelemetryQueryKey("disagreement", key), value)
}

/**
 * Telemetry rows of one kind, as `[sessionKey, value]` pairs.
 *
 * The QueryClient hands back `unknown`, so the caller supplies the guard for the
 * kind it asked for rather than the reader asserting a type parameter it never
 * checked. All three payloads are written by this module, so the guards check
 * the identity field each one is keyed and read by.
 */
function queryEntries<T>(kind: TelemetryKind, isValue: (value: unknown) => value is T) {
  return queryClient.getQueryCache().findAll({ queryKey: telemetryPrefix(kind) }).flatMap((query) => {
    const key = query.queryKey[3]
    if (typeof key !== "string") return []
    const data = query.state.data
    return isValue(data) ? [[key, data] as const] : []
  })
}

function isStatusSnapshot(value: unknown): value is StatusSnapshot {
  const row = asRecord(value)
  return typeof row?.sessionID === "string" && typeof row.at === "number"
}

function isMatchingPollBucket(value: unknown): value is MatchingPollBucket {
  const row = asRecord(value)
  return Array.isArray(row?.entries) && typeof row.total === "number"
}

function isPollDisagreement(value: unknown): value is SessionStatusPollDisagreement {
  const row = asRecord(value)
  return typeof row?.sessionID === "string" && typeof row.count === "number"
    && typeof row.firstSeenAt === "number" && typeof row.lastSeenAt === "number"
}

function latestObservedDirectory(input: {
  event?: StatusSnapshot
  disagreement?: SessionStatusPollDisagreement
  latestMatch?: StatusSnapshot
}) {
  return [
    ...(input.event ? [{ directory: input.event.directory, at: input.event.at }] : []),
    ...(input.disagreement ? [{ directory: input.disagreement.directory, at: input.disagreement.lastSeenAt }] : []),
    ...(input.latestMatch ? [{ directory: input.latestMatch.directory, at: input.latestMatch.at }] : []),
  ]
    .sort((a, b) => b.at - a.at)
    .find((item) => item.directory)?.directory
}

export function observeSessionStatusEvent(input: {
  directory?: string
  sessionID: string
  status?: SessionStatus
  now?: number
}) {
  setEventSnapshot(statusKey(input.sessionID), {
    directory: input.directory,
    sessionID: input.sessionID,
    status: input.status,
    at: input.now ?? Date.now(),
  })
}

export function observeSessionStatusPoll(input: {
  directory?: string
  sessionID: string
  status?: SessionStatus
  now?: number
}) {
  const event = eventSnapshot(statusKey(input.sessionID))
  if (!event) return
  const key = statusKey(input.sessionID)
  const now = input.now ?? Date.now()
  if (statusFingerprint(event.status) === statusFingerprint(input.status)) {
    const bucket = matchingPollBucket(key) ?? { entries: [], total: 0 }
    const entries = [...bucket.entries, {
      directory: input.directory,
      sessionID: input.sessionID,
      status: input.status,
      at: now,
    }]
    trimSnapshots(entries, now)
    setMatchingPollBucket(key, { entries, total: bucket.total + 1 })
    return
  }
  const existing = pollDisagreement(key)
  setPollDisagreement(key, {
    directory: input.directory,
    sessionID: input.sessionID,
    eventStatus: event.status,
    polledStatus: input.status,
    count: (existing?.count ?? 0) + 1,
    firstSeenAt: existing?.firstSeenAt ?? now,
    lastSeenAt: now,
  })
}

export function sessionStatusPollDisagreements() {
  return queryEntries("disagreement", isPollDisagreement).map((item) => item[1])
}

function recentMatchingPollCount(key: string | undefined, now: number) {
  if (key) {
    const bucket = matchingPollBucket(key)
    if (!bucket) return 0
    const entries = [...bucket.entries]
    trimSnapshots(entries, now)
    if (entries.length !== bucket.entries.length) setMatchingPollBucket(key, { ...bucket, entries })
    return entries.length
  }
  let total = 0
  for (const [bucketKey, bucket] of queryEntries("matches", isMatchingPollBucket)) {
    const entries = [...bucket.entries]
    trimSnapshots(entries, now)
    if (entries.length !== bucket.entries.length) setMatchingPollBucket(bucketKey, { ...bucket, entries })
    total += entries.length
  }
  return total
}

function hasRecentDisagreement(disagreements: SessionStatusPollDisagreement[], now: number) {
  return disagreements.some((item) => now - item.lastSeenAt <= T_RECOVER_MS)
}

export function sessionStatusPollingRemovalGate(input?: {
  directory?: string
  sessionID?: string
  now?: number
}) {
  // Scoped query requires sessionID; without it the call is a global query
  // (whole-fleet view). `now` can be passed in either shape.
  const key = input?.sessionID ? statusKey(input.sessionID) : undefined
  const now = input?.now ?? Date.now()
  const disagreements = key
    ? sessionStatusPollDisagreements().filter((item) => item.sessionID === key)
    : sessionStatusPollDisagreements()
  const eventStatusCount = key ? eventSnapshot(key) ? 1 : 0 : queryEntries("event", isStatusSnapshot).length
  const matchingPollCount = recentMatchingPollCount(key, now)

  if (eventStatusCount === 0) {
    return {
      canDisablePolling: false,
      reason: "missing-event-evidence" as const,
      eventStatusCount,
      matchingPollCount,
      disagreements,
    }
  }
  // Sliding-window recovery: a disagreement older than T_RECOVER_MS does not
  // block the gate as long as recent matching evidence has accumulated.
  if (hasRecentDisagreement(disagreements, now)) {
    return {
      canDisablePolling: false,
      reason: "poll-event-disagreement" as const,
      eventStatusCount,
      matchingPollCount,
      disagreements,
    }
  }
  if (matchingPollCount < N_MATCHES_REQUIRED) {
    return {
      canDisablePolling: false,
      reason: "missing-matching-poll-evidence" as const,
      eventStatusCount,
      matchingPollCount,
      disagreements,
    }
  }
  return {
    canDisablePolling: true,
    reason: "event-path-clean" as const,
    eventStatusCount,
    matchingPollCount,
    disagreements,
  }
}

// Exporter surface for telemetry/observability. The polling-removal gate is a
// property of fleet-wide evidence; a single dev box's view is rarely the
// right one. This snapshot is the contract the telemetry exporter publishes
// (logger, analytics, devtools panel — whichever the project wires up),
// rather than evidence sitting in a write-only map nothing ever reads.
export type SessionStatusTelemetrySnapshot = {
  generatedAt: number
  config: {
    recoverMs: number
    windowMs: number
    matchesRequired: number
  }
  sessions: Array<{
    key: string
    directory?: string
    sessionID: string
    eventStatus?: SessionStatus
    eventAt?: number
    matchingPollsInWindow: number
    matchingPollsTotal: number
    lastDisagreementAt?: number
    disagreementCount: number
    canDisablePolling: boolean
    reason:
      | "missing-event-evidence"
      | "poll-event-disagreement"
      | "missing-matching-poll-evidence"
      | "event-path-clean"
  }>
}

export function getSessionStatusTelemetrySnapshot(now: number = Date.now()): SessionStatusTelemetrySnapshot {
  const keys = new Set<string>()
  for (const [key] of queryEntries("event", isStatusSnapshot)) keys.add(key)
  for (const [key] of queryEntries("matches", isMatchingPollBucket)) keys.add(key)
  for (const [key] of queryEntries("disagreement", isPollDisagreement)) keys.add(key)

  const sessions: SessionStatusTelemetrySnapshot["sessions"] = []
  for (const key of keys) {
    const gate = sessionStatusPollingRemovalGate({
      sessionID: key,
      now,
    })
    const event = eventSnapshot(key)
    const disagreement = pollDisagreement(key)
    const bucket = matchingPollBucket(key)
    const latestMatch = bucket?.entries.at(-1)
    const directory = latestObservedDirectory({
      ...(event ? { event } : {}),
      ...(disagreement ? { disagreement } : {}),
      ...(latestMatch ? { latestMatch } : {}),
    })
    sessions.push({
      key,
      ...(directory ? { directory } : {}),
      sessionID: key,
      ...(event?.status ? { eventStatus: event.status } : {}),
      ...(event ? { eventAt: event.at } : {}),
      matchingPollsInWindow: bucket?.entries.length ?? 0,
      matchingPollsTotal: bucket?.total ?? 0,
      ...(disagreement ? { lastDisagreementAt: disagreement.lastSeenAt } : {}),
      disagreementCount: disagreement?.count ?? 0,
      canDisablePolling: gate.canDisablePolling,
      reason: gate.reason,
    })
  }

  return {
    generatedAt: now,
    config: {
      recoverMs: T_RECOVER_MS,
      windowMs: T_WINDOW_MS,
      matchesRequired: N_MATCHES_REQUIRED,
    },
    sessions,
  }
}

// Expose the telemetry snapshot via a window-attached debug accessor so
// developers can inspect the polling-removal gate state from
// the browser console without code injection. Guarded by the same env
// var the dev server already gates other debug helpers on; in production
// builds (`__CLAXEDO_DEBUG__` is false / undefined) the accessor is not
// attached. Safe to call multiple times — calling it again replaces the
// previous accessor.
export function installSessionStatusTelemetryDevtools() {
  if (typeof window === "undefined") return
  const debugEnabled =
    readField(globalThis, "__CLAXEDO_DEBUG__") === true ||
    (typeof process !== "undefined" && process.env?.CLAXEDO_DEBUG === "1")
  if (!debugEnabled) return
  // Debug-only browser hook: it extends Window outside the typed runtime surface,
  // so it is attached rather than assigned through an asserted Window shape.
  Object.assign(window, {
    __claxedoPollingGate: {
      snapshot: (now?: number) => getSessionStatusTelemetrySnapshot(now),
      config: SESSION_STATUS_TELEMETRY_CONFIG,
      reset: () => resetSessionStatusTelemetryForTest(),
    },
  })
}

export function resetSessionStatusTelemetryForTest() {
  queryClient.removeQueries({ queryKey: telemetryPrefix() })
}

export const SESSION_STATUS_TELEMETRY_CONFIG = {
  recoverMs: T_RECOVER_MS,
  windowMs: T_WINDOW_MS,
  matchesRequired: N_MATCHES_REQUIRED,
} as const
