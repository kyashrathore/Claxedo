import { createEffect, createMemo, createSignal, on, type Accessor } from "solid-js"
import type {
  AgentPermission as PermissionRequest,
  AgentQuestion as QuestionRequest,
} from "@claxedo/agent-runtime-contract"
import { nextUnseenDone, sessionSurfaceActive } from "../compact-switcher/surface-status"
import { pruneRailSessionActivityMap, type RailSessionStatusTarget } from "./rail-session-status-target"
import { railRowStatusType } from "./rail-sidebar.logic"
import { mergeRailRequestRead, mergeRailStatusRead, stampRailStatusRead } from "./rail-sidebar-status"

/** The auto-response predicate as its one consumer declares it. */
type PermissionAutoResponder = NonNullable<Parameters<typeof sessionSurfaceActive>[0]["autoResponds"]>

export type RailSessionRowRequests = {
  permissions?: PermissionRequest[]
  questions?: QuestionRequest[]
}

export type RailSessionRowInput = Pick<RailSessionStatusTarget, "directory"> & {
  statusType: string | undefined
  requests: RailSessionRowRequests | undefined
  failed: boolean
}

export type RailSessionActivity = {
  /** Per-row status inputs, keyed by target key. The rail renders rows from this. */
  rowInputs: Accessor<Map<string, RailSessionRowInput>>
  /** Rows whose turn finished while they were neither focused nor observed. */
  unseenDone: Accessor<Record<string, true | undefined>>
  /** Fold one directory batch read into the projection. */
  applyBatchRead: (read: {
    targets: readonly RailSessionStatusTarget[]
    readStartedAt: number
    statuses?: Record<string, { type?: string }>
    permissions?: PermissionRequest[]
    questions?: QuestionRequest[]
  }) => void
}

/**
 * The rail's per-row status projection: what each visible row's status inputs
 * are, and which rows finished a turn nobody watched.
 *
 * Owns the three maps the projection is built from, so the only thing that can
 * change them is a batch read. That ownership is the point. The maps used to
 * live in `rail-sidebar.tsx` next to a single effect that READ all of them —
 * through `rowInputs` — and WROTE all of them, to drop the entries of rows that
 * had gone away. An effect whose writes land in its own dependency set answers
 * its own write with another run, and Solid pays for each extra generation with
 * a `runUpdates`/`completeUpdates` frame pair of JS stack — the shape that, in
 * `workspace-gate.tsx`, ran the stack out entirely.
 *
 * So neither job reads what it writes:
 *
 * - dropping the entries of rows that are gone depends on the TARGET SET and
 *   nothing else, so it is keyed on it with `on()`, whose callback Solid runs
 *   untracked;
 * - unseen-done is a derivation, not a side effect: it is a fold over the
 *   previous answer, so it is a memo carrying the activity it compared against
 *   rather than an effect writing a signal.
 */
export function createRailSessionActivity(input: {
  targets: Accessor<readonly RailSessionStatusTarget[]>
  focusedTarget: Accessor<RailSessionStatusTarget | undefined>
  /** Bumped by the rail's session-activity subscriptions; re-reads the non-reactive sources below. */
  activityRevision: Accessor<number>
  /** The session-id status cache, written by the routed workspace's stream; only the focused pane's entry is resynced across a gap. */
  liveStatusType: (sessionID: string) => string | undefined
  /** When this client's own send optimistically marked the session busy. */
  optimisticStartedAt: (sessionID: string) => number | undefined
  /** Whether the session's last turn ended in an error, from the same session-id cache. */
  turnFailed: (sessionID: string) => boolean
  autoResponds: PermissionAutoResponder
}): RailSessionActivity {
  const [statuses, setStatuses] = createSignal<Record<string, string | undefined>>({})
  // When the batch read that produced `statuses[key]` was ISSUED, per target.
  // `railRowStatusType` needs it to tell a background row's optimistic busy
  // from a batch answer that already superseded it.
  const [statusReadAt, setStatusReadAt] = createSignal<Record<string, number | undefined>>({})
  const [requests, setRequests] = createSignal<Record<string, RailSessionRowRequests | undefined>>({})

  const rowInputs = createMemo(() => {
    input.activityRevision()
    const batchStatuses = statuses()
    const readAt = statusReadAt()
    const rowRequests = requests()
    const focusedSessionId = input.focusedTarget()?.sessionID
    return new Map(input.targets().map((target) => {
      const optimisticStartedAt = input.optimisticStartedAt(target.sessionID)
      return [
        target.key,
        {
          directory: target.directory,
          statusType: railRowStatusType({
            batchType: batchStatuses[target.key],
            liveType: input.liveStatusType(target.sessionID),
            focused: focusedSessionId === target.sessionID,
            ...(optimisticStartedAt !== undefined ? { optimisticStartedAt } : {}),
            ...(readAt[target.key] !== undefined ? { batchReadStartedAt: readAt[target.key] } : {}),
          }),
          requests: rowRequests[target.key],
          failed: input.turnFailed(target.sessionID),
        },
      ] as const
    }))
  })

  const rowActive = createMemo(() => {
    const rows = rowInputs()
    return new Map(input.targets().map((target) => {
      const row = rows.get(target.key)
      return [
        target.key,
        sessionSurfaceActive({
          statusType: row?.statusType,
          requests: row?.requests,
          directory: row?.directory ?? target.directory,
          autoResponds: input.autoResponds,
        }),
      ] as const
    }))
  })

  // The rows the projection may hold an entry for, as a plain snapshot: a batch
  // answers for the rows that were on screen when it was issued, and this is
  // what tells `applyBatchRead` which of them are still there.
  let liveKeys = new Set<string>()
  createEffect(on(input.targets, (targets) => {
    liveKeys = new Set(targets.map((target) => target.key))
    setStatuses((current) => pruneRailSessionActivityMap(current, targets))
    setStatusReadAt((current) => pruneRailSessionActivityMap(current, targets))
    setRequests((current) => pruneRailSessionActivityMap(current, targets))
  }))

  const unseen = createMemo<{ done: Record<string, true | undefined>; active: Map<string, boolean> }>(
    (previous) => {
      const active = rowActive()
      const focusedKey = input.focusedTarget()?.key
      const done: Record<string, true | undefined> = {}
      for (const target of input.targets()) {
        if (!nextUnseenDone({
          active: active.get(target.key) ?? false,
          previousActive: previous.active.get(target.key),
          focused: target.key === focusedKey,
          current: !!previous.done[target.key],
        })) continue
        done[target.key] = true
      }
      const keys = Object.keys(done)
      const unchanged = keys.length === Object.keys(previous.done).length &&
        keys.every((key) => previous.done[key])
      return { done: unchanged ? previous.done : done, active }
    },
    { done: {}, active: new Map() },
  )
  // A fold cannot be evaluated lazily and still be correct: it compares against
  // the last activity it SAW. A collapsed rail renders no rows, so nothing would
  // read this, and a background turn that started and finished behind it would
  // land on an `active` map from before it began — no transition, no dot. This
  // subscriber keeps the fold running on every change instead of on every read.
  createEffect(() => void unseen())

  return {
    rowInputs,
    unseenDone: () => unseen().done,
    applyBatchRead: (read) => {
      // A batch is issued for the rows on screen when it starts and answers some
      // time later, so it can name a row that has gone since. Dropping those
      // here keeps every map keyed by live rows alone, which is what lets the
      // effect above key on the target set instead of reading what it writes.
      const targets = read.targets.filter((target) => liveKeys.has(target.key))
      if (targets.length === 0) return
      if (read.statuses) {
        const readStatuses = read.statuses
        setStatuses((current) => mergeRailStatusRead(current, targets, readStatuses))
        setStatusReadAt((current) => stampRailStatusRead(current, targets, read.readStartedAt))
      }
      if (read.permissions || read.questions) {
        setRequests((current) => mergeRailRequestRead(current, targets, read.permissions, read.questions))
      }
    },
  }
}
