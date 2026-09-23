export const sessionMessageTopMargin = 12

export function sessionMessageScrollInset(input: { rootTop: number; stickyBottom: number }) {
  return Math.max(0, input.stickyBottom - input.rootTop) + sessionMessageTopMargin
}

export function sessionMessageScrollTop(input: {
  currentScrollTop: number
  rootTop: number
  stickyBottom: number
  targetTop: number
}) {
  const inset = sessionMessageScrollInset(input)
  return Math.max(0, input.currentScrollTop + input.targetTop - input.rootTop - inset)
}

/** Resume bottom anchoring before and after the virtualizer's next layout pass. */
export function resumeSessionScroll(input: {
  clearMessageSelection: () => void
  clearMessageHash: () => void
  resumeAutoScroll: () => void
  scrollToEnd: () => void
  scheduleScrollState: () => void
}) {
  input.clearMessageSelection()
  input.clearMessageHash()
  input.resumeAutoScroll()
  input.scrollToEnd()
  input.scheduleScrollState()
  requestAnimationFrame(() => {
    input.scrollToEnd()
    input.scheduleScrollState()
  })
}
