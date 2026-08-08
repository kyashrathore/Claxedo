import type { ClaxedoEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import type { ControlPlaneAuthContext } from "../auth/auth"

// Worker-safe home of the per-event visibility predicate. Both the local Node
// bus SSE (`routes/events.ts`) and the hosted `LiveSyncRoom` Durable Object
// (`src/deployments/hosted-workerd/live-sync-room.cf.ts`) import this ONE function so the central event
// stream applies identical scoping in both deployments. The imports here are
// TYPE-ONLY (both `ClaxedoEvent` and `ControlPlaneAuthContext` erase at build),
// so nothing runtime (e.g. the process-local `claxedoBus`) is pulled — this
// module is safe to reach from the Cloudflare Worker bundle.

/**
 * The subscriber identity the event plane scopes on.
 *
 * NAMESPACE CONTRACT — the event plane's org identity is the
 * AUTHORITY-INTERNAL org id (Convex `orgs._id`, SQLite `org_id`), NEVER the
 * Clerk `org_...` claim. Events are stamped with internal ids at publish
 * (documents routes scope via `authority.resolveOrgId`, provision via
 * `Workspace.org_id`, WorkGraph runtime tokens carry the launch tenant's
 * internal org id), so the subscriber side must present the SAME namespace:
 * `orgId` here is resolved via `authority.resolveOrgId(auth)` at subscribe
 * time. Passing the raw Clerk claim compares disjoint namespaces and silently
 * blinds the subscriber to every org-scoped event. `subject` is the Clerk
 * subject (`user_...`) — subjects are shared across both namespaces.
 *
 * `orgId` is the caller's ACTIVE org: the org matching their Clerk org claim
 * when they are a member, else their personal org (`resolveOrgId` is total for
 * signed callers). Absent only when no authority is composed to resolve it —
 * then org-scoped events are invisible, fail-closed.
 */
export type EventScopePrincipal =
  | { mode: "unsigned-local" }
  | { mode: "signed"; subject: string; orgId?: string }

/**
 * The ONE constructor of a signed subscriber principal from a resolved auth
 * context. `resolvedOrgId` MUST come from `authority.resolveOrgId(auth)` —
 * this helper deliberately never reads `auth.user.orgId` (the Clerk claim),
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
// New event types added to the ClaxedoEvent union are therefore invisible to
// signed subscribers until they carry a scope and gain a rule here — they can
// leak by omission of delivery, never by omission of authorization.
export function eventVisibleTo(principal: EventScopePrincipal, event: ClaxedoEvent): boolean {
  // Single-user modes: the whole bus belongs to this caller.
  if (principal.mode === "unsigned-local") return true

  switch (event.type) {
    case "workgraph.changed":
      // ownerUserId is stamped from auth.user.subject at publish
      // (server-workgraph.ts); "local" marks unsigned-local publishes.
      return event.ownerUserId === principal.subject
    case "document.changed":
      // event.orgId is the authority-internal org id (documents routes scope
      // via `authority.resolveOrgId`); principal.orgId is resolved through the
      // same authority call at subscribe time, so both sides share a namespace.
      return !!principal.orgId && event.orgId === principal.orgId
    case "provision":
      // orgId is stamped from Workspace.org_id at publish (provision-events.ts)
      // — the same authority-internal namespace as principal.orgId. Org-less
      // (local) workspaces stay invisible to signed subscribers.
      return !!principal.orgId && event.orgId === principal.orgId
    default:
      // pty.*, agent.lifecycle, process.*, session.lifecycle, worktree.* carry
      // no owner identity: they are local-execution events whose hosted
      // equivalents flow on per-workspace runtime streams (routed off by
      // workspaceRuntimeProxy before this handler), so a signed subscriber to
      // the central stream is never their legitimate consumer.
      return false
  }
}
