import type { PtyInfo } from "@claxedo/workspace-runtime/host"
import { jsonRecord } from "./json"

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

export type { PtyInfo }

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
// `orgId`/`projectId` are required so a consumer can filter to its own project.
// `orgId` is the AUTHORITY-INTERNAL org id (`authority.resolveOrgId` at the
// documents routes — the authority's internal org id (SQLite `org_id`), NEVER the issuer org
// claim) and is enforced server-side (`platform/http/event-visibility.ts`: signed
// subscribers resolve the same internal id at connect and only see their own
// org's events); `projectId` remains a client-side routing hint.
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
  phase: "granted" | "revoked"
  /** Recipient's auth subject — visibility matches session-share scoping. */
  ownerUserId: string
  sessionId: string
  workspaceId: string
  /** Authority-internal org id for hosted LiveSync room routing. */
  orgId?: string
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
 * What the control plane tells its clients on `cp/events`: something changed
 * and the reader re-reads. Never a session's content — that is the workspace
 * runtime's stream. One bus, one publisher per event kind: the sandbox
 * provisioner, the worktree routes, the documents backend, the session-share
 * authority.
 */
export type ControlPlaneEvent =
  | {
      type: "provision"
      workspaceId: string
      /**
       * Org that owns the workspace (`Workspace.org_id`, the AUTHORITY-INTERNAL
       * org id namespace), stamped at publish. `routes/event-visibility.ts`
       * uses it to scope delivery in signed mode (subscribers resolve the same
       * internal id at connect); absent (local workspaces) means the event is
       * only visible to unsigned-local/loopback subscribers.
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
  | SessionInventoryChangedEvent

export const controlBus = createBus<ControlPlaneEvent>()
