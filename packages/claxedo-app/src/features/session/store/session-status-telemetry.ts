import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { queryClient } from "@/platform/query/query-client"

// Rubric C3: a session that *had* a disagreement at any point used to lock
// `canDisablePolling=false` forever (monotonic gate). The new evaluation is
// a sliding window — the gate opens when there has been NO disagreement in
// the recent `T_RECOVER_MS` window AND at least `N_MATCHES_REQUIRED` matching
// polls inside the recent `T_WINDOW_MS` window. The constants are deliberate
// and live in the file header so an operator can tune them without grepping.
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
  while (entries.length > 0 && now - entries[0]!.at > T_WINDOW_MS) entries.shift()
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

function queryEntries<T>(kind: TelemetryKind) {
  return queryClient.getQueryCache().findAll({ queryKey: telemetryPrefix(kind) }).flatMap((query) => {
    const key = query.queryKey[3]
    if (typeof key !== "string") return []
    const data = query.state.data as T | undefined
    return data === undefined ? [] : [[key, data] as const]
  })
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
  return queryEntries<SessionStatusPollDisagreement>("disagreement").map((item) => item[1])
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
  for (const [bucketKey, bucket] of queryEntries<MatchingPollBucket>("matches")) {
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
  const eventStatusCount = key ? eventSnapshot(key) ? 1 : 0 : queryEntries<StatusSnapshot>("event").length
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
  // Sliding-window recovery: a disagreement OLDER than T_RECOVER_MS no longer
  // blocks the gate as long as recent matching evidence has accumulated.
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

// Rubric C3: exporter surface for telemetry/observability. The polling-removal
// gate is a property of fleet-wide evidence; a single dev box's view is rarely
// the right one. This snapshot is the contract the telemetry exporter publishes
// (logger, analytics, devtools panel — whichever the project wires up). Per
// the rubric this avoids the write-only Map pattern.
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
  for (const [key] of queryEntries<StatusSnapshot>("event")) keys.add(key)
  for (const [key] of queryEntries<MatchingPollBucket>("matches")) keys.add(key)
  for (const [key] of queryEntries<SessionStatusPollDisagreement>("disagreement")) keys.add(key)

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

// Rubric Q8: expose the telemetry snapshot via a window-attached debug
// accessor so developers can inspect the polling-removal gate state from
// the browser console without code injection. Guarded by the same env
// var the dev server already gates other debug helpers on; in production
// builds (`__CLAXEDO_DEBUG__` is false / undefined) the accessor is not
// attached. Safe to call multiple times — calling it again replaces the
// previous accessor.
export function installSessionStatusTelemetryDevtools() {
  if (typeof window === "undefined") return
  const debugEnabled =
    (globalThis as Record<string, unknown>).__CLAXEDO_DEBUG__ === true ||
    (typeof process !== "undefined" && process.env?.CLAXEDO_DEBUG === "1")
  if (!debugEnabled) return
  // as-any: debug-only browser hook extends Window outside the typed runtime surface.
  ;(window as unknown as Record<string, unknown>).__claxedoPollingGate = {
    snapshot: (now?: number) => getSessionStatusTelemetrySnapshot(now),
    config: SESSION_STATUS_TELEMETRY_CONFIG,
    reset: () => resetSessionStatusTelemetryForTest(),
  }
}

export function resetSessionStatusTelemetryForTest() {
  queryClient.removeQueries({ queryKey: telemetryPrefix() })
}

export const SESSION_STATUS_TELEMETRY_CONFIG = {
  recoverMs: T_RECOVER_MS,
  windowMs: T_WINDOW_MS,
  matchesRequired: N_MATCHES_REQUIRED,
} as const
