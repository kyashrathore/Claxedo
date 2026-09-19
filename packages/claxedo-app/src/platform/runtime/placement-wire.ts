/**
 * A workspace's placement, and the wire this client reaches it over.
 *
 * The server states ONE fact about a workspace: the machine it runs on and the
 * directory it occupies there. `loopback` versus `relay` is this client's own
 * answer to "is that machine me", computed here and nowhere else, never
 * persisted and never sent.
 *
 * The words `local`, `cloud` and `user-hosted` are the CONTROL PLANE's, on the
 * wire only: a project inventory row's `kind`, a control-plane row's `backing`,
 * and the `?access=` list scope. This module is the only translator between
 * them and the placement the rest of the app reads.
 */

import { asRecord } from "@/lib/record"

/**
 * The word a project-inventory row's `kind` is written with on the wire.
 *
 * Three producers write it: the daemon's own store (`local` / `cloud`), the
 * hosted control plane's shell projects and a self-hosted node's signed
 * bootstrap (`user-hosted` / `cloud`). Rows keep it; readers narrow it with
 * {@link inventoryHostKind}.
 */
export type InventoryKindWord = "local" | "cloud" | "user-hosted"

/**
 * The machine a workspace runs on.
 *
 * `self` is the server this client is attached to serving its own directory —
 * the loopback daemon's inventory, and an unsigned self-hosted node's. A
 * `machine` with no enrollment id is a published workspace no host currently
 * holds: the control plane knows it exists and can name no machine for it.
 */
export type WorkspaceHost =
  | { kind: "self" }
  | { kind: "machine"; enrollmentId?: string }
  | { kind: "provisioner" }

export type WorkspaceHostKind = WorkspaceHost["kind"]

/** The hosts a workspace the attached server does not serve itself runs on. */
export type RelayHostKind = Exclude<WorkspaceHostKind, "self">

export type WorkspacePlacement = {
  host: WorkspaceHost
  /** Where the host keeps the workspace on ITS filesystem. Never addressed by. */
  directory?: string
}

/**
 * This client's own machine, as the attached server declares it in its
 * bootstrap body (`host.enrollment`).
 *
 * `none` is a client attached to a server that serves no directories of its
 * own — every browser on the hosted app. `unenrolled` is a loopback daemon
 * that has not enrolled: it still serves its own directories, so they are
 * still reached over loopback; it simply cannot recognise itself in a
 * control-plane row.
 */
export type SelfHost =
  | { kind: "none" }
  | { kind: "unenrolled" }
  | { kind: "enrolled"; enrollmentId: string }

/**
 * `unreachable` is a placement with no machine to send a request to. It is not
 * a failure to route: nothing is opened, nothing is retried, and the surface
 * says the machine is offline.
 */
export type PlacementWire = "loopback" | "relay" | "unreachable"

export function placementWire(placement: WorkspacePlacement, self: SelfHost): PlacementWire {
  if (placement.host.kind === "self") return "loopback"
  if (placement.host.kind === "provisioner") return "relay"
  if (!placement.host.enrollmentId) return "unreachable"
  return self.kind === "enrolled" && self.enrollmentId === placement.host.enrollmentId ? "loopback" : "relay"
}

/** Whether a host this client cannot serve itself is named at all. */
export function isRelayHostKind(kind: WorkspaceHostKind | null | undefined): kind is RelayHostKind {
  return kind === "machine" || kind === "provisioner"
}

/**
 * The host kind a project-inventory row's `kind` states.
 *
 * Three producers write that field and each spells the same three placements
 * its own way: the daemon's own store (`local` / `cloud`), the hosted control
 * plane's shell projects and the self-hosted node's signed bootstrap
 * (`user-hosted` / `cloud`).
 */
export function inventoryHostKind(input: unknown): WorkspaceHostKind | undefined {
  if (input === "local") return "self"
  if (input === "cloud") return "provisioner"
  if (input === "user-hosted") return "machine"
  return undefined
}

/** The wire word a host kind is written as on a project-inventory row. */
export function inventoryKindWord(kind: WorkspaceHostKind): InventoryKindWord {
  if (kind === "self") return "local"
  if (kind === "provisioner") return "cloud"
  return "user-hosted"
}

/**
 * A host kind that has travelled as a plain string through app-internal data —
 * a session row's `environment.kind`, a stored draft. Not a wire word.
 */
export function asHostKind(input: unknown): WorkspaceHostKind | undefined {
  return input === "self" || input === "machine" || input === "provisioner" ? input : undefined
}

/**
 * The host kind a control-plane row's `backing` states.
 *
 * The control plane stores where a workspace runs, not how a client reaches
 * it: `cloud-vm` is the provisioner's machine and `local-worktree` is an
 * enrolled one. It emits no kind of its own.
 */
export function backingHostKind(input: unknown): RelayHostKind | undefined {
  if (input === "cloud-vm") return "provisioner"
  if (input === "local-worktree") return "machine"
  return undefined
}

/**
 * The list scope the control plane's workspace routes name.
 *
 * `GET /api/workspace?access=` and the account bridge's `workspace.list.*`
 * operations answer one placement each, under the vocabulary those routes were
 * built with. Kept here so the app states it once, at the same boundary that
 * reads it back off a row.
 */
export function controlPlaneListScope(kind: RelayHostKind): "cloud" | "user-hosted" {
  return kind === "provisioner" ? "cloud" : "user-hosted"
}

/**
 * The placement a control-plane workspace row states.
 *
 * `undefined` is a row this build cannot interpret — a backing it does not
 * know. A `local-worktree` row naming no host is a placement with an unknown
 * machine, which is a placement, not an unreadable row.
 */
export function controlPlaneRowPlacement(input: unknown): WorkspacePlacement | undefined {
  const row = asRecord(input)
  const kind = backingHostKind(row?.backing)
  if (!kind) return undefined
  const placement = asRecord(row?.placement)
  const directory = text(placement?.directory) ?? text(row?.remote_directory) ?? text(row?.remoteDirectory)
  if (kind === "provisioner") return { host: { kind }, ...(directory ? { directory } : {}) }
  const enrollmentId = text(placement?.host_enrollment_id) ?? text(placement?.hostEnrollmentId)
  return {
    host: { kind, ...(enrollmentId ? { enrollmentId } : {}) },
    ...(directory ? { directory } : {}),
  }
}

/**
 * The host kind a raw inventory or session row reports.
 *
 * A daemon row states its own `kind`; a control-plane row states only where it
 * runs, so its `backing` is mapped. The one owner for this derivation, shared
 * by the global sync inventory reducer and the session inventory query.
 */
export function rowHostKind(input: unknown): WorkspaceHostKind | undefined {
  const row = asRecord(input)
  return inventoryHostKind(row?.kind) ?? backingHostKind(row?.backing)
}

function text(input: unknown) {
  return typeof input === "string" && input ? input : undefined
}
