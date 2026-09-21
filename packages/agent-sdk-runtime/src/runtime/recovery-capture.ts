import type { RecoveryTarget, RecoveryTurnTarget } from "@claxedo/agent-runtime-contract"
import type { RuntimeDirectory } from "../index"
import type { AgentRuntimeEventEnvelope } from "./contracts"
import type { TurnAdmissionFence } from "./turn-admission"

/**
 * The turn identity every recovery and finalization effect is checked against.
 * A turn a provider admitted for itself — a Goal iteration, say — has no
 * runtime generation or lease, and the owner states that by leaving those out
 * rather than by minting one that means nothing.
 */
export type RecoveryTurnCapture = {
  sessionId: string
  directory?: RuntimeDirectory
  /** The in-process generation, when this runtime admitted the turn. */
  admission?: object
  /** The durable turn lease, when this owner holds one for it. */
  leaseId?: string
  turnId?: string
  assistantMessageId?: string
  fence?: TurnAdmissionFence
  target: RecoveryTarget
}

export type AdmittedTurnCapture = RecoveryTurnCapture & {
  admission: object
  leaseId: string
  turnId: string
  assistantMessageId: string
  target: RecoveryTurnTarget
}

export type TurnFinalization =
  /** `wrote` is false when the store accepted the call and recorded nothing. */
  | { ok: true; wrote: boolean }
  /** Another generation owns the session; this effect has nothing to finish. */
  | { ok: false; reason: "superseded" }
  /** This owner holds neither the admission nor the lease for that turn. */
  | { ok: false; reason: "no_authority" }
  | { ok: false; reason: "authority_lost"; error?: unknown }
  | { ok: false; reason: "persistence"; error: unknown }

export type FinalizeTurnOptions = {
  emit?: (event: AgentRuntimeEventEnvelope) => void
  /**
   * Publish the canonical idle frame. A cancelled turn needs it because its
   * producer may never yield again; a turn that reached its own terminal event
   * has already published one, and a second would be a duplicate.
   */
  announceIdle?: boolean
}
