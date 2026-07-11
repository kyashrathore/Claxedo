// target-layer: shell/review

export type ReviewRegionPolicyState = {
  key?: string
  armed: boolean
}

export function reviewRegionPolicy(input: {
  key?: string
  prev?: ReviewRegionPolicyState
  ready: boolean
}) {
  const sameKey = !!input.key && input.prev?.key === input.key
  return {
    key: input.key,
    armed: !!input.key && (input.ready || (sameKey && input.prev?.armed === true)),
    showPending: !!input.key && !input.ready,
  }
}
