import { workspaceRuntimeBus as runtimeBus, type WorkspaceRuntimeEvent as RuntimeClaxedoEvent, type PtyInfo } from "@claxedo/workspace-runtime/host"

type Subscriber<T> = (event: T) => unknown

type BusOptions<T> = {
  onSubscriberError?: (error: unknown, event: T) => void
}

function catches(value: unknown): value is Promise<unknown> {
  return typeof (value as { catch?: unknown } | null)?.catch === "function"
}

export function createBus<T>(options: BusOptions<T> = {}) {
  const subs = new Set<Subscriber<T>>()

  function report(error: unknown, event: T) {
    try {
      if (options.onSubscriberError) {
        options.onSubscriberError(error, event)
        return
      }
      console.error("claxedoBus subscriber failed", error)
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

// Canonical session.lifecycle envelope. The frontend re-exports
// this from `shared/claxedo-client` so consumers (event reducer, the create
// wrapper, the ClaxedoEvents provider) share one type definition.
export type SessionLifecycleEvent = {
  type: "session.lifecycle"
  phase: "creating" | "created" | "failed"
  directory: string
  sessionID?: string
  workspaceId?: string
  draftId?: string
  info?: unknown
  message?: string
  ts: number
}

// Doorbell nudge for Documents live sync.
//
// Publisher: the claxedo-server documents backend, from its save paths (see
// `documents/backend.ts` `publishDocumentEvent`). External-change detection and
// the per-surface `GET /documents/events` SSE were REMOVED; this
// doorbell on the central events stream is the sole live-sync mechanism.
// Consumer: claxedo-app `features/documents`, via the central events stream.
//
// ⚠ SHAPE COLLISION — read before wiring. A DIFFERENT `document.changed` payload
// exists in-process on the legacy `subscribeDocumentEvents` listener registry: it
// is snake_case and wider (`document_id`, `org_id`, `project_id`, `reason`,
// `invalidate`, `ts`; see `documents/backend.ts`). This bus envelope is camelCase,
// matching every other event in this union. The two share a `type` discriminant
// but are NOT interchangeable: convert at the boundary, never pass through.
//
// `orgId`/`projectId` are required so a consumer can filter to its own project.
// `orgId` is the AUTHORITY-INTERNAL org id (`authority.resolveOrgId` at the
// documents routes — the authority's internal org id (SQLite `org_id`), NEVER the issuer org
// claim) and is enforced server-side (`routes/event-visibility.ts`: signed
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
// Consumer: claxedo-app session rail/inventory via the central events stream —
// invalidate and refetch (list APIs already include shares).
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

type ControlEvent =
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
  | SessionLifecycleEvent
  | DocumentChangedEvent
  | SessionShareChangedEvent

export type ClaxedoEvent = RuntimeClaxedoEvent | ControlEvent

export const claxedoBus = runtimeBus as {
  publish(event: ClaxedoEvent): void
  subscribe(fn: Subscriber<ClaxedoEvent>): () => void
}

export type OpenCodeEvent = {
  type: string
  properties?: Record<string, unknown>
}

export type GlobalEvent = {
  directory?: string
  payload: OpenCodeEvent
}

export const globalBus = createBus<GlobalEvent>()
