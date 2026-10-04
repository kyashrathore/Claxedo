import type { RuntimeSessionAuthorityOptions } from "../routes/runtime-session-authority"

type TurnLeaseVerifier = NonNullable<RuntimeSessionAuthorityOptions["verifyTurnLease"]>
export type TurnLeaseClaims = Awaited<ReturnType<TurnLeaseVerifier>>

export type TurnLeaseProofs = {
  verifyTurnLease: TurnLeaseVerifier
  /** The session authority's own recheck of the chain behind a turn lease. */
  turnLeaseDenial(claims: TurnLeaseClaims): Promise<unknown>
}

/**
 * The turn a sandbox request is proven by: the lease its admission was issued,
 * however long ago the request that queued it ended, while the actor behind it
 * may still run it. `invalid` and `denied` are the two refusals a caller maps
 * to its own answer.
 */
export async function turnLeaseAuthority(proofs: TurnLeaseProofs, lease: string): Promise<TurnLeaseClaims | "invalid" | "denied"> {
  let claims: TurnLeaseClaims
  try {
    claims = await proofs.verifyTurnLease(lease)
  } catch {
    return "invalid"
  }
  return await proofs.turnLeaseDenial(claims) ? "denied" : claims
}
