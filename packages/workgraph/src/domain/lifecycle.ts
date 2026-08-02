export type StreamRemovalEligibility =
  | { readonly eligible: true; readonly action: "delete" }
  | {
      readonly eligible: false
      readonly action: "close"
      readonly error: {
        readonly code: "close_required"
        readonly durableEffectCount: number
      }
    }

export type StreamRemovalCommitResult =
  | { readonly ok: true; readonly action: "deleted" }
  | {
      readonly ok: false
      readonly action: "close"
      readonly error: { readonly code: "durable_effect_race"; readonly durableEffectCount: number }
    }

/** Advisory preflight only. The store must atomically recheck receipts while deleting. */
export function streamRemovalEligibility(durableEffectCount: number): StreamRemovalEligibility {
  if (!Number.isSafeInteger(durableEffectCount) || durableEffectCount < 0) {
    throw new RangeError("durableEffectCount must be a non-negative safe integer")
  }
  if (durableEffectCount === 0) return { eligible: true, action: "delete" }
  return {
    eligible: false,
    action: "close",
    error: { code: "close_required", durableEffectCount },
  }
}
