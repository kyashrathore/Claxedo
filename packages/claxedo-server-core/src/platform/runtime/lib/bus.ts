import { jsonRecord } from "./json"
import type { SessionShareLevel } from "../../auth/session-share-level"

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

/**
 * Some Page in `projectId` changed. The doorbell names no Page and no version:
 * a Page is private to its creator until shared, and every `cp/events` filter
 * decides on the subscriber's subject and org alone, so anything finer would
 * reach org members the Page is not shared with. A reader re-reads its Page
 * list, and that read applies Page access.
 *
 * `orgId` is the authority-internal org id (`authority.resolveOrgId`, never the
 * issuer's org claim). `projectId` names nothing an org member cannot already
 * read: every member holds at least read on every project of the org.
 *
 * Publisher: `publishDocumentEvent` in `documents/backend.ts`, the one place
 * the documents backend's own snake_case listener payload, which names the
 * Page, is narrowed to this.
 */
export type DocumentChangedEvent = {
  type: "document.changed"
  orgId: string
  projectId: string
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
 * A workspace's session inventory gained or lost a row in the control plane's
 * own projection — the one the rail lists from. A doorbell with no session
 * named: the reader re-reads the inventory, and the read applies access.
 * Membership only: a title or model change is the runtime's own frame on
 * `wr/events`, and rings nothing here.
 */
export type SessionInventoryChangedEvent = WorkspaceNotice & { type: "session.inventory.changed" }

/** A notice about one workspace. A workspace is its owner's, so the notice is too. */
type WorkspaceNotice = {
  workspaceId: string
  /** Authority-internal org id (`Workspace.org_id`); absent for a machine's own workspaces. */
  orgId?: string
  /**
   * The owner's auth subject (`ControlPlaneAuthContext.user.subject`), the only
   * signed subscriber the notice reaches. Absent when the publishing
   * composition has no authority to name the owner, which leaves the notice to
   * the unsigned local operator.
   */
  ownerUserId?: string
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
 * and the reader re-reads. Never a session's content — that is the workspace
 * runtime's stream. One bus, one publisher per event kind: the sandbox
 * provisioner, the worktree routes, the documents backend, the session-share
 * authority, the session-meta store (`session/meta/index.ts`), the usage quota
 * reader (`usage/quota.ts`).
 *
 * The local daemon and a self-hosted node serve all seven kinds. The hosted
 * plane's room (`hosted-workerd/live-sync-room.cf.ts`) carries `provision`,
 * `document.changed` and `session.share.changed` only: worktrees are a
 * machine's, and the hosted worker has no publisher for
 * `session.inventory.changed`, so a signed web client on it learns of a
 * session created elsewhere by its next inventory read, not by a notice.
 */
export type ControlPlaneEvent =
  | WorkspaceNotice & {
      type: "provision"
      step: "acquiring_sandbox" | "cloning" | "starting_runtime" | "waiting_health" | "ready" | "error"
      message?: string
      totalMs?: number
    }
  | { type: "worktree.ready"; directory: string; name: string; branch: string }
  | { type: "worktree.failed"; directory: string; message: string }
  | DocumentChangedEvent
  | SessionShareChangedEvent
  | SessionInventoryChangedEvent
  | UsageQuotaChangedEvent
  | PluginsChangedEvent

export const controlBus = createBus<ControlPlaneEvent>()
