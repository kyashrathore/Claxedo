import { createHash } from "node:crypto";
import type { EventEnvelope } from "./event-log";
import type { IHashChain } from "./hash-chain";

// ---------------------------------------------------------------------------
// NodeHashChain — node:crypto-backed implementation of IHashChain
// ---------------------------------------------------------------------------

// To swap the hashing backend, implement IHashChain and replace
// openNodeHashChain() calls with the new factory. The class below
// and SqliteEventStore are unchanged.

class NodeHashChain implements IHashChain {
  async computeHash(event: EventEnvelope, prevHash: string): Promise<string> {
    const input = `${prevHash}${event.type}${event.payload_json}${event.run_id}${event.stream_seq}`;
    return createHash("sha256").update(input).digest("hex");
  }

  async verifyChain(
    events: EventEnvelope[],
  ): Promise<{ valid: boolean; brokenAt?: number }> {
    for (let i = 0; i < events.length; i++) {
      const event = events[i]
      if (!event) return { valid: false, brokenAt: i }
      const prev = i === 0 ? null : events[i - 1]
      const prevHash = prev?.hash ?? "00000000"
      const computed = await this.computeHash(event, prevHash);
      if (computed !== event.hash) {
        return { valid: false, brokenAt: i };
      }
    }
    return { valid: true };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an IHashChain backed by node:crypto (SHA-256).
 *
 * @example
 *   const hasher = openNodeHashChain()
 *   const hash = await hasher.computeHash(event, prevHash)
 */
export function openNodeHashChain(): IHashChain {
  return new NodeHashChain();
}

// ---------------------------------------------------------------------------
// Module-level convenience exports (backwards-compatible)
// ---------------------------------------------------------------------------

const _defaultHasher = new NodeHashChain();

export const computeHash = (event: EventEnvelope, prevHash: string): Promise<string> =>
  _defaultHasher.computeHash(event, prevHash);

export const verifyChain = (events: EventEnvelope[]): Promise<{ valid: boolean; brokenAt?: number }> =>
  _defaultHasher.verifyChain(events);
