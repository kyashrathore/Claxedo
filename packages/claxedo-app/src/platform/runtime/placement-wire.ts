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
 * One producer writes it now: the daemon's own store, whose workspace row has
 * a `kind` column (`local` / `cloud`) and no backing. The app mints it back
 * for its own catalog rows through {@link inventoryKindWord} so both halves of
 * one inventory map read alike. Every other inventory producer states
 * `backing` instead, which is why a row is narrowed by {@link rowHostKind}
 * rather than by this word alone.
 */
export type InventoryKindWord = "local" | "cloud" | "user-hosted"

/**
 * A value a wire narrower will accept: anything but a host kind this app
 * already produced.
 *
 * The two vocabularies share no member, so narrowing one with the other's
 * reader answers `undefined` and kills the branch with nothing to see at the
 * call site. `unknown` in that position is what a raw row needs, so the
 * exclusion is spelled here instead: `[Exclude<…>]` is non-distributive on
 * purpose, or a `WorkspaceHostKind | undefined` — which is what every
 * `workspace?.kind` reads as — would slip through on the `undefined` arm.
 */
type NotAHostKind<T> = [Exclude<T, null | undefined>] extends [WorkspaceHostKind] ? never : unknown

/** The mirror: an app host kind reader will not accept a wire word. */
type NotAWireWord<T> = [Exclude<T, null | undefined>] extends [InventoryKindWord] ? never : unknown

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
 * Whether the attached server serves this workspace itself.
 *
 * Not the negation of {@link isRelayHostKind}: a placement that names no host
 * is neither, and a caller that reads "not relayed" as "mine" opens a local
 * runtime for a workspace nothing has placed.
 */
export function isSelfHostKind(kind: WorkspaceHostKind | null | undefined): kind is "self" {
  return kind === "self"
}

/**
 * The workspace half of a persisted model document's key.
 *
 * A workspace the attached server holds is keyed by its directory there; one a
 * machine or the provisioner holds is keyed by its id, because that directory
 * is a path on somebody else's filesystem and two of them can collide. A pane
 * and the Settings Models page must derive it the same way or they edit two
 * documents while believing they share one, so each narrows its own producer's
 * word to a host kind and asks here.
 */
export function modelStoreWorkspaceKey(input: {
  host: WorkspaceHostKind | null | undefined
  workspaceId?: string
  hostDirectory: string
}) {
  return isRelayHostKind(input.host) && input.workspaceId ? input.workspaceId : input.hostDirectory
}

/**
 * The host kind a project-inventory row's `kind` states.
 *
 * Only the daemon's own store and the app's own catalog projection write that
 * field. A reader holding a whole row asks {@link rowHostKind}; this narrows
 * the word once it has been read off one.
 */
export function inventoryHostKind<T>(input: T & NotAHostKind<T>): WorkspaceHostKind | undefined {
  if (input === "local") return "self"
  if (input === "cloud") return "provisioner"
  if (input === "user-hosted") return "machine"
  return undefined
}

export function inventoryKindWord(kind: WorkspaceHostKind): InventoryKindWord {
  if (kind === "self") return "local"
  if (kind === "provisioner") return "cloud"
  return "user-hosted"
}

/**
 * A host kind that has travelled as a plain string through app-internal data —
 * a session row's `environment.kind`, a stored draft. Not a wire word.
 */
export function asHostKind<T>(input: T & NotAWireWord<T>): WorkspaceHostKind | undefined {
  const value: unknown = input
  return value === "self" || value === "machine" || value === "provisioner" ? value : undefined
}

/**
 * The host kind a control-plane row's `backing` states.
 *
 * The control plane stores where a workspace runs, not how a client reaches
 * it: `cloud-vm` is the provisioner's machine and `local-worktree` is an
 * enrolled one. It emits no kind of its own.
 */
export function backingHostKind<T>(input: T & NotAHostKind<T>): RelayHostKind | undefined {
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
 * The provisioner a row's placement names, when one owns the machine.
 *
 * Only a provisioner placement has one: a machine's own worktree is not
 * provisioned, and reporting its `local-worktree` backing as a driver names a
 * thing that does not exist. The id is passed through as the placement wrote
 * it — a deployment may provision through a bridge this build has no catalog
 * entry for, and a provisioner this client cannot name is still the one that
 * owns the machine.
 */
export function placementProvisioner(input: unknown): string | undefined {
  const row = asRecord(input)
  if (rowHostKind(row) !== "provisioner") return undefined
  return text(row?.driver) ?? text(asRecord(row?.backing)?.driver)
}

/**
 * The host kind an inventory or session row reports, whichever word its
 * producer states it in.
 *
 * The producers do not agree and cannot: the daemon's store has a `kind`
 * column and no backing, while the signed bootstrap
 * (`claxedo-local-server/.../bootstrap.ts`) and the hosted shell
 * (`claxedo-server/src/routes/hosted/shell.ts`) pass the control plane's
 * `backing` through and write no kind. Reading only one of the two answers
 * `undefined` for half the rows in circulation, which every caller spells as
 * "not relay-backed" and routes at the wrong server.
 *
 * `kind` is preferred where a row carries both, because it is the serving
 * process writing about itself.
 */
export function rowHostKind(input: unknown): WorkspaceHostKind | undefined {
  const row = asRecord(input)
  return inventoryHostKind(row?.kind) ?? backingHostKind(row?.backing)
}

function text(input: unknown) {
  return typeof input === "string" && input ? input : undefined
}
