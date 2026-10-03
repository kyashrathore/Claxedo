import type { ControlPlaneEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import type { ControlPlaneAuthContext } from "@claxedo/server-core/platform/auth/auth"

// Worker-safe home of the per-event visibility predicate. Both the local
// daemon's `cp/events` handler (`claxedo-local-server/src/shell/events.ts`)
// and the hosted `LiveSyncRoom` Durable Object
// (`src/deployments/hosted-workerd/live-sync-room.cf.ts`) import this ONE
// function so the control plane's stream applies identical scoping in both
// deployments. The imports here are
// TYPE-ONLY (both `ControlPlaneEvent` and `ControlPlaneAuthContext` erase at build),
// so nothing runtime (e.g. the process-local `controlBus`) is pulled — this
// module is safe to reach from the Cloudflare Worker bundle.

/**
 * The subscriber identity the event plane scopes on.
 *
 * `orgId` is the caller's active org as the AUTHORITY-INTERNAL org id
 * (`authority.resolveOrgId(auth)` at subscribe time, never the identity
 * provider's `org_...` claim). `subject` is the canonical application user id
 * (`usr_...`), which private notices name as their recipient and room owner.
 */
export type EventScopePrincipal =
  | { mode: "unsigned-local" }
  | { mode: "signed"; subject: string; orgId?: string }

/**
 * The ONE constructor of a signed subscriber principal from a resolved auth
 * context. `resolvedOrgId` MUST come from `authority.resolveOrgId(auth)` —
 * this helper deliberately never reads `auth.user.orgId` (the issuer claim),
 * so a caller cannot smuggle the wrong namespace in by omission.
 */
export function eventScopePrincipal(
  ctx: ControlPlaneAuthContext,
  resolvedOrgId?: string,
): EventScopePrincipal {
  if (ctx.mode !== "signed") return { mode: "unsigned-local" }
  return {
    mode: "signed",
    subject: ctx.user.subject,
    ...(resolvedOrgId ? { orgId: resolvedOrgId } : {}),
  }
}

// Per-event authorization: authenticating a subscriber is not
// enough — the bus is server-global, so without a per-event filter any valid
// bearer (any user, any org) would observe every other tenant's events.
// Allowlist with default-deny: an event type is only delivered to a signed
// subscriber if it has an explicit scope rule matching the caller's identity.
// New event types added to the ControlPlaneEvent union are therefore invisible to
// signed subscribers until they carry a scope and gain a rule here — they can
// leak by omission of delivery, never by omission of authorization.
export function eventVisibleTo(principal: EventScopePrincipal, event: ControlPlaneEvent): boolean {
  // Single-user modes: the whole bus belongs to this caller.
  if (principal.mode === "unsigned-local") return true

  switch (event.type) {
    case "session.share.changed":
    case "session.status.changed":
    case "session.removed":
    case "session.attention.raised":
    case "session.reader.changed":
      // ownerUserId names the canonical recipient, including shared-session readers.
      return event.ownerUserId === principal.subject
    case "usage.quota.changed":
      // Carries no figures and names no account: the quota read it provokes
      // is what applies `operator_required`.
      return true
    default:
      // A Page notice names a Page its creator may not have shared; a
      // provision or inventory notice is about one person's workspace; and
      // worktree.* is a local daemon's notice about its own checkout. None
      // reaches a signed subscriber, only the unsigned machine's single user.
      return false
  }
}
