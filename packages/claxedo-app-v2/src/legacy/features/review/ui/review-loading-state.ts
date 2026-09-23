export function reviewDiffsReady(input: { loading: boolean; diffCount: number }) {
  return !input.loading || input.diffCount > 0
}

export function reviewShouldShowLoadingPane(input: { loading: boolean; diffCount: number }) {
  return input.loading && input.diffCount === 0
}
