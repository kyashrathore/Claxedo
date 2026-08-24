/**
 * Completed Markdown is readable as plain text for the first paint. Rich
 * projection starts after the interaction budget, so Marked, DOMPurify, Shiki,
 * Mermaid, and DOM decoration cannot compete with a cold surface mount.
 */
export const completedMarkdownRichDelayMs = 96

export function scheduleCompletedMarkdownRichUpgrade(
  upgrade: () => void,
  delayMs = completedMarkdownRichDelayMs,
) {
  let active = true
  const timeout = setTimeout(() => {
    if (!active) return
    active = false
    upgrade()
  }, Math.max(0, delayMs))

  return () => {
    if (!active) return
    active = false
    clearTimeout(timeout)
  }
}
