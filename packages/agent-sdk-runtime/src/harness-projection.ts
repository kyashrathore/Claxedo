import { HARNESS_TABLE, type HarnessId } from "@claxedo/agent-runtime-contract"
import type { ProviderProjection } from "./provider-projection"

/**
 * The projection a harness runs its next turn on, or nothing when no account is
 * selected for it.
 *
 * A projection map is keyed by registry provider id, and a harness answers to
 * several: a Claude turn can be bound through `claude-sdk` or through a plain
 * `anthropic` key. `HARNESS_TABLE` lists them in the order the operator's
 * selection is meant to be read, connect provider first. Every other key in the
 * map belongs to a different harness and decides nothing here — an account
 * bound for Claude must not route a Cursor turn.
 */
export function harnessProjection(
  auth: Record<string, ProviderProjection> | undefined,
  harnessId: HarnessId,
): ProviderProjection | undefined {
  if (!auth) return undefined
  for (const providerId of HARNESS_TABLE[harnessId].providerIds) {
    const projection = auth[providerId]
    if (projection) return projection
  }
  return undefined
}
