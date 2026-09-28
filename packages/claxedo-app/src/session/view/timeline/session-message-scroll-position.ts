const sessionMessageTopMargin = 12

export function sessionMessageScrollInset(input: { rootTop: number; stickyBottom: number }) {
  return Math.max(0, input.stickyBottom - input.rootTop) + sessionMessageTopMargin
}
