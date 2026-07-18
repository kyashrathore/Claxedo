import type { ClaxedoEvent } from "../bus"
import type { ControlPlaneAuthContext } from "../control-plane/auth"

// Worker-safe home of the per-event visibility predicate. Both the local Node
// bus SSE (`routes/events.ts`) and the hosted `LiveSyncRoom` Durable Object
// (`src/live-sync-room.ts`) import this ONE function so the central event
// stream applies identical scoping in both deployments. The imports here are
// TYPE-ONLY (both `ClaxedoEvent` and `ControlPlaneAuthContext` erase at build),
// so nothing runtime (e.g. the process-local `claxedoBus`) is pulled — this
// module is safe to reach from the Cloudflare Worker bundle.
//
// Rubric S1 + per-event authorization: authenticating a subscriber is not
// enough — the bus is server-global, so without a per-event filter any valid
// bearer (any user, any org) would observe every other tenant's events.
// Allowlist with default-deny: an event type is only delivered to a signed
// subscriber if it has an explicit scope rule matching the caller's identity.
// New event types added to the ClaxedoEvent union are therefore invisible to
// signed subscribers until they carry a scope and gain a rule here — they can
// leak by omission of delivery, never by omission of authorization.
export function eventVisibleTo(ctx: ControlPlaneAuthContext, event: ClaxedoEvent): boolean {
  // Single-user modes: the whole bus belongs to this caller.
  if (ctx.mode === "unsigned-local") return true

  switch (event.type) {
    case "workgraph.changed":
      // ownerUserId is stamped from auth.user.subject at publish
      // (server-workgraph.ts); "local" marks unsigned-local publishes.
      return event.ownerUserId === ctx.user.subject
    case "document.changed":
      return !!ctx.user.orgId && event.orgId === ctx.user.orgId
    case "provision":
      // orgId is stamped from Workspace.org_id at publish (provision-events.ts);
      // org-less (local) workspaces stay invisible to signed subscribers.
      return !!ctx.user.orgId && event.orgId === ctx.user.orgId
    default:
      // pty.*, agent.lifecycle, process.*, session.lifecycle, worktree.* carry
      // no owner identity: they are local-execution events whose hosted
      // equivalents flow on per-workspace runtime streams (routed off by
      // workspaceRuntimeProxy before this handler), so a signed subscriber to
      // the central stream is never their legitimate consumer.
      return false
  }
}
