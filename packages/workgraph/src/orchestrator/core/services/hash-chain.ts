import type { EventEnvelope } from "../../events";

/**
 * Adapter-agnostic interface for hash-chain operations.
 *
 * To swap the hashing backend, implement this interface and pass the new
 * implementation wherever IHashChain is required. The current implementation
 * is NodeHashChain in hash-chain-node.ts.
 */
export interface IHashChain {
  /** Compute a deterministic SHA-256 hash for one event, chaining from prevHash. */
  computeHash(event: EventEnvelope, prevHash: string): Promise<string>;
  /** Verify the integrity of an ordered event chain. */
  verifyChain(events: EventEnvelope[]): Promise<{ valid: boolean; brokenAt?: number }>;
}
