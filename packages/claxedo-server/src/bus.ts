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

// Canonical session.lifecycle envelope (rubric D4). The frontend re-exports
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

// Doorbell nudge for WorkGraph live sync.
//
// Publisher: the claxedo-server WorkGraph host, post-commit — after appended
// `wg_v2_changes` rows become readable — coalesced (~100ms trailing) so a burst
// of mutations emits one nudge.
// Consumer: claxedo-app `features/workgraph`, via the central events stream, which
// debounce-reloads the snapshot + attention. It replaces the deleted
// `GET /api/workgraph/changes` long-poll.
//
// This carries NO payload beyond identity on purpose: it is a doorbell, not a
// change envelope. The client re-reads state (R1); the ordered `wg_v2_changes`
// log stays server-side for settlement/wakes/audit.
//
// `ownerUserId` scopes the nudge (WorkGraph is owner-scoped). It is set from
// the authenticated `auth.user.subject` at publish ("local" in unsigned-local
// mode) and `routes/events.ts` enforces it server-side: signed subscribers
// only receive events whose ownerUserId matches their own subject. The reload
// it triggers is additionally authorized per-request by the snapshot endpoint.
export type WorkgraphChangedEvent = {
  type: "workgraph.changed"
  ownerUserId: string
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
// `orgId` is enforced server-side by `routes/events.ts` (signed subscribers only
// see their own org's events); `projectId` remains a client-side routing hint.
export type DocumentChangedEvent = {
  type: "document.changed"
  documentId: string
  orgId: string
  projectId: string
  /** Absent when the change is not a content write (e.g. rename/archive). */
  version?: string
  ts: number
}

type ControlEvent =
  | {
      type: "provision"
      workspaceId: string
      /**
       * Org that owns the workspace (`Workspace.org_id`), stamped at publish.
       * `routes/events.ts` uses it to scope delivery in signed mode; absent
       * (local workspaces) means the event is only visible to unsigned-local/
       * loopback subscribers.
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
  | WorkgraphChangedEvent
  | DocumentChangedEvent

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
