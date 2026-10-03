import type { BackgroundWork, SessionLastTurn } from "@claxedo/agent-runtime-contract"
import { jsonRecord } from "./json"
import type { SessionShareLevel } from "../../auth/session-share-level"
import type { SessionRowStatusKind } from "../../../session/navigation-list"

type Subscriber<T> = (event: T) => unknown

type BusOptions<T> = {
  onSubscriberError?: (error: unknown, event: T) => void
}

function catches(value: unknown): value is Promise<unknown> {
  return typeof jsonRecord(value)?.catch === "function"
}

export function createBus<T>(options: BusOptions<T> = {}) {
  const subs = new Set<Subscriber<T>>()

  function report(error: unknown, event: T) {
    try {
      if (options.onSubscriberError) {
        options.onSubscriberError(error, event)
        return
      }
      console.error("bus subscriber failed", error)
    } catch {}
  }

  return {
    publish(event: T) {
      subs.forEach((fn) => {
        try {
          const result = fn(event)
          if (catches(result)) void result.catch((error) => report(error, event))
        } catch (error) {
          report(error, event)
        }
      })
    },
    subscribe(fn: Subscriber<T>) {
      subs.add(fn)
      return () => subs.delete(fn)
    },
  }
}

// Doorbell nudge for Documents live sync: the one live-sync mechanism a
// document has. It carries no content, so an open editor is not refreshed by
// it — an external write surfaces as a CAS conflict on the next save.
//
// Publisher: the documents backend, from its save paths
// (`documents/backend.ts` `publishDocumentEvent`).
// Consumer: claxedo-app `features/documents`, off `cp/events`, to refresh
// the document INDEX.
//
// ⚠ SHAPE COLLISION — read before wiring. A DIFFERENT `document.changed` payload
// exists in-process on the `subscribeDocumentEvents` listener registry: it
// is snake_case and wider (`document_id`, `org_id`, `project_id`, `reason`,
// `invalidate`, `ts`; see `documents/backend.ts`). This bus envelope is camelCase,
// matching every other event in this union. The two share a `type` discriminant
// but are NOT interchangeable: convert at the boundary, never pass through.
//
// It names a Page, which is private to its creator until shared, so
// `platform/http/event-visibility.ts` delivers it to no signed subscriber.
export type DocumentChangedEvent = {
  type: "document.changed"
  documentId: string
  orgId: string
  projectId: string
  /** Absent when the change is not a content write (e.g. rename/archive). */
  version?: string
  ts: number
}

// Doorbell nudge for session-share live sync.
//
// Publisher: control-plane share grant/revoke HTTP handlers, after the
// authority write succeeds. One event per recipient subject.
// Consumer: claxedo-app session rail/inventory, off `cp/events` — invalidate
// and refetch (list APIs already include shares).
//
// This remains a doorbell, not a change envelope. `ownerUserId` is the
// *recipient* subject, NOT the granter — which is the whole reason this event
// is owner-scoped rather than org-scoped: Bob receives Alice's grant without
// Alice seeing Bob's doorbell. `eventVisibleTo` enforces that per connection.
export type SessionShareChangedEvent = {
  type: "session.share.changed"
  /** Recipient's auth subject — visibility matches session-share scoping. */
  ownerUserId: string
  sessionId: string
  workspaceId: string
  /** Authority-internal org id for hosted LiveSync room routing. */
  orgId?: string
  ts: number
} & (
  /** A downgrade rings `granted` at the narrower level: the share still exists. */
  | { phase: "granted"; level: SessionShareLevel }
  | { phase: "revoked" }
)

/**
 * A session's list status as the hosted registry holds it after a machine or
 * cloud runtime published a row that changed its status, wait, background
 * work or last turn. One per reader: `ownerUserId` is the recipient subject
 * (the session's owner or a person it is shared with), never the publisher.
 * Unlike a doorbell it carries the state, so a reader updates the row in
 * place instead of re-reading the list.
 */
export type SessionStatusChangedEvent = {
  type: "session.status.changed"
  ownerUserId: string
  /** Authority-internal org id of the session: the room its readers are held in. */
  orgId: string
  sessionId: string
  workspaceId: string
  status: SessionRowStatusKind
  awaitingInput: boolean
  backgroundWork?: BackgroundWork
  lastTurn?: SessionLastTurn
  /** When the runtime reported the status, as the registry holds it. */
  ts: number
}

/**
 * A workspace's session inventory gained or lost a row in the control plane's
 * own projection — the one the rail lists from. A doorbell with no session
 * named: the reader re-reads the inventory, and the read applies access.
 * Membership only: a title or model change is the runtime's own frame on
 * `wr/events`, and rings nothing here.
 */
export type SessionInventoryChangedEvent = {
  type: "session.inventory.changed"
  workspaceId: string
  /** Authority-internal org id, when the workspace has one; absent for a machine's own workspaces. */
  orgId?: string
  ts: number
}

/**
 * Figures for the Usage-limits view landed from one of their sources: a stored
 * account's Check, the harnesses' own logins, or the machine-wide probe. Names
 * nothing, so it carries nothing a subscriber could not already read; the
 * quota read decides who sees the figures.
 */
export type UsageQuotaChangedEvent = {
  type: "usage.quota.changed"
  ts: number
}

/**
 * A live plugin registered with this daemon changed: a build started,
 * landed at `hash`, failed (the last good `hash` stays served), or the
 * plugin was removed. A doorbell: the app re-reads the live-plugins list.
 *
 * Publisher: the daemon's live-plugin service
 * (`claxedo-local-server/src/plugins/service.ts`). A machine's own notice,
 * so `event-visibility.ts` keeps it from signed subscribers.
 */
export type PluginsChangedEvent = {
  type: "plugins.changed"
  pluginId: string
  status: "building" | "ready" | "failed" | "removed"
  hash?: string
  ts: number
}

/**
 * What the control plane tells its clients on `cp/events`: something changed
 * and the reader re-reads, or a session's list status as it stands. Never a
 * session's content — that is the workspace runtime's stream. One bus, one
 * publisher per event kind: the sandbox provisioner, the worktree routes, the
 * documents backend, the session-share authority, the hosted session-row
 * ingest, the session-meta store (`session/meta/index.ts`), the usage quota
 * reader (`usage/quota.ts`).
 *
 * The local daemon serves every kind it publishes to its unsigned user. A
 * signed subscriber gets only share, status and quota notices
 * (`event-visibility.ts`), and the hosted plane's room
 * (`hosted-workerd/live-sync-room.cf.ts`) carries `session.share.changed` and
 * `session.status.changed` alone, so a signed client learns of a provision
 * step or a Page change by its next read, not by a notice.
 */
export type ControlPlaneEvent =
  | {
      type: "provision"
      workspaceId: string
      /**
       * Org that owns the workspace (`Workspace.org_id`, the AUTHORITY-INTERNAL
       * org id namespace), stamped at publish; absent for local workspaces.
       */
      orgId?: string
      step: "acquiring_sandbox" | "cloning" | "starting_runtime" | "waiting_health" | "ready" | "error"
      message?: string
      totalMs?: number
      ts: number
    }
  | { type: "worktree.ready"; directory: string; name: string; branch: string }
  | { type: "worktree.failed"; directory: string; message: string }
  | DocumentChangedEvent
  | SessionShareChangedEvent
  | SessionStatusChangedEvent
  | SessionInventoryChangedEvent
  | UsageQuotaChangedEvent
  | PluginsChangedEvent

export const controlBus = createBus<ControlPlaneEvent>()
