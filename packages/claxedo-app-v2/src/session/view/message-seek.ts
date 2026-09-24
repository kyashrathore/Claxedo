const SEEK_ATTEMPTS = 6

function rowInView(root: HTMLElement, messageId: string): boolean {
  const row = root.querySelector(`[id="message-${CSS.escape(messageId)}"]`)
  if (!row) return false
  const box = root.getBoundingClientRect()
  const top = row.getBoundingClientRect().top
  return top >= box.top - 1 && top < box.bottom
}

export function createMessageSeek(input: { readonly scroller: () => HTMLElement | undefined; readonly scrollTo: (messageId: string) => boolean }) {
  let run = 0
  const step = (messageId: string, current: number, left: number) => {
    const root = input.scroller()
    if (current !== run || left === 0 || !root || rowInView(root, messageId)) return
    input.scrollTo(messageId)
    requestAnimationFrame(() => requestAnimationFrame(() => step(messageId, current, left - 1)))
  }
  return {
    seek: (messageId: string) => {
      run += 1
      step(messageId, run, SEEK_ATTEMPTS)
    },
    cancel: () => {
      run += 1
    },
  }
}
