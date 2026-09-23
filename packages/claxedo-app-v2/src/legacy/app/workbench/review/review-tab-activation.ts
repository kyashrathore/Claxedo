export type PreparedReviewTabActivation = Readonly<{ id: string }>

export function createReviewTabActivation(input: {
  current: () => string
  reviewTabId: string
  captureReview: () => void
  commit: (id: string) => void
}) {
  const prepare = (id: string): PreparedReviewTabActivation => {
    if (input.current() === input.reviewTabId && id !== input.reviewTabId) input.captureReview()
    return { id }
  }
  const commit = (activation: PreparedReviewTabActivation) => input.commit(activation.id)
  const activate = (id: string) => commit(prepare(id))

  return { activate, commit, prepare }
}
