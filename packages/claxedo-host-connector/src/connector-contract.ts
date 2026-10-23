/**
 * What a connected machine and the control plane say to each other: the
 * acquire and heartbeat a machine signs, the answers it applies, and the
 * transport that carries them. Types only, so the connector and its callers
 * share one statement of the protocol without a runtime edge.
 */

import type { HostScope } from "./host-state"

/**
 * How a runtime composed its session access, mirroring
 * `SessionAccessPolicy.sessionAuthority` in `@claxedo/workspace-runtime` and
 * `HostSessionAuthority` at the control plane. Restated here rather than
 * imported because this package depends on neither: it is a laptop-side
 * client that holds a machine key and speaks one protocol.
 */
export type HostSessionAuthority = "local" | "managed-private"

export type Enrollment = { enrollment_id: string; host_id: string; expires_at: number }

/** The owner's statement of what this machine should serve, versioned per workspace. */
export type AssignmentDescription = {
  workspaceId: string
  remoteDirectory: string
  displayName?: string
  /** Strictly increasing; bumped with every change to the directory. */
  revision: number
}

export type AssignmentAck = { workspaceId: string; revision: number }

export type HostEndpoints = {
  relay?: { url: string; jwksUrl: string }
  authority?: { sessionAuthorityUrl: string }
  /** Where this machine publishes its sessions' list rows with its Host Tunnel Token. */
  sessionRows?: { url: string }
}

/**
 * The owner's provider configuration for this machine, versioned like an
 * assignment and carried the same way.
 *
 * `sealed` is opaque here: it is a `mseal1` blob for this machine's sealing
 * key (`./machine-seal`) and only the process holding that key opens it. The
 * connector never reads it, so a change to what the owner pushes is not a
 * change to this package. `null` is the withdrawal — a revision that says
 * "this machine holds nothing" — and it is a revision like any other so a host
 * that was offline when the owner revoked learns of it on its next beat.
 */
export type ProviderConfigRevision = { revision: number; sealed: string | null }

export type HeartbeatResponse = {
  expires_at: number
  assigned_workspace_ids?: readonly string[]
  /** ONE credential covering the whole assigned∩ready set, or absent. */
  hostTunnel?: Record<string, unknown>
  assignments?: readonly AssignmentDescription[]
  scope?: HostScope
  /** Present only when the control plane holds a revision this machine has not acked. */
  providerConfig?: ProviderConfigRevision
  /** The pass this machine presents to its owner's desktop broker, while it serves and reports a direct listener. */
  ownerBrokerPass?: OwnerBrokerPass
} & HostEndpoints

/** Opaque here, like `sealed`: only the owner's desktop broker reads it. */
export type OwnerBrokerPass = { token: string; expiresAt: number }

/**
 * Where a client on this machine's own network reaches it without the relay:
 * one TLS port on each private-network address, behind a certificate whose
 * public key hashes (SHA-256 over the DER SubjectPublicKeyInfo, base64url) to
 * `spkiSha256`.
 */
export type DirectRoutes = { port: number; addresses: readonly string[]; spkiSha256: string }

/** The request signature covers the whole body, so it carries no payload signature of its own. */
export type MachineHeartbeatInput = {
  generation: number
  acks: readonly AssignmentAck[]
  ttlMs?: number
  sessionAuthority?: HostSessionAuthority
  /**
   * The public half of this machine's sealing key (`./machine-seal`), declared
   * on every beat so the control plane can seal a secret for it.
   *
   * Sent every time rather than once at enrollment: the enrollment handshake
   * predates it, a re-enrolled machine mints a new pair, and one column in an
   * UPDATE the beat already runs costs nothing. A machine that declares none
   * can be pushed nothing, which is what a machine with no opener should get.
   */
  sealingPublicKey?: string
  /** The provider-config revision this machine has STORED; the answer restates it only when it differs. */
  providerConfigRevision?: number
  /** Absent when nothing listens: the switch is off, or the machine has no private-network address. */
  directRoutes?: DirectRoutes
}

export type MachineTransport = {
  /**
   * Claim the next serving generation; every earlier instance's beats are
   * refused from then on. `timeoutMs` bounds this one request below the
   * transport's own bound, for a caller spending a retry budget.
   */
  acquire: (input?: { timeoutMs?: number }) => Promise<{ generation: number }>
  /**
   * One signed beat carries the lease renewal AND the acked set. The answer
   * carries the owner's current descriptions, the scope, the endpoints, and
   * one Host Tunnel credential covering every workspace that is both assigned
   * and acked — the serving side opens its relay tunnels from the same answer
   * that renewed the lease.
   */
  heartbeat: (input: MachineHeartbeatInput) => Promise<HeartbeatResponse>
  /**
   * Hold the control plane's doorbell open: `onEvent` fires whenever the
   * owner changes what this machine serves, and the connector answers with a
   * beat. Without it a change waits for the interval. A transport that
   * cannot hold a stream leaves this undefined.
   */
  watch?: (listener: { onEvent: () => void; onError?: (error: unknown) => void }) => { close: () => void }
}
