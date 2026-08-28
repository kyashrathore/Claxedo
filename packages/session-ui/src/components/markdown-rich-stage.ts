/**
 * Completed Markdown must not paint escaped source and then morph into rich
 * HTML. Warm remounts hit the module-scope parse/highlight caches and commit
 * rich on the first frame. Cold mounts start the rich pipeline immediately and
 * wait for it; they never stage a plain-text first paint.
 *
 * Per-body paint memory still records that a completed body has committed
 * real rich HTML, so remounts and tests can distinguish cache hits from the
 * first rich commit.
 */
export const completedMarkdownRichDelayMs = 96

const completedMarkdownPaintLimits = { entries: 4096 }
const painted = new Map<string, string>()

function completedMarkdownPaintKey(cacheKey: string | undefined, text: string) {
  return cacheKey ? `k:${cacheKey}` : `t:${text}`
}

export function rememberCompletedMarkdownPaint(cacheKey: string | undefined, text: string) {
  const key = completedMarkdownPaintKey(cacheKey, text)
  if (painted.has(key)) painted.delete(key)
  painted.set(key, text)
  while (painted.size > completedMarkdownPaintLimits.entries) {
    const oldest = painted.keys().next().value
    if (oldest === undefined) break
    painted.delete(oldest)
  }
}

export function hasCompletedMarkdownPaint(cacheKey: string | undefined, text: string) {
  const key = completedMarkdownPaintKey(cacheKey, text)
  const stored = painted.get(key)
  if (stored !== text) return false
  painted.delete(key)
  painted.set(key, stored)
  return true
}

export function clearCompletedMarkdownPaintCache() {
  painted.clear()
}

export function shouldStageCompletedMarkdown(input: {
  streaming?: boolean
  delayMs: number
  cacheKey?: string
  text: string
}) {
  if (input.streaming) return false
  if (input.delayMs <= 0) return false
  if (!input.text) return false
  return false
}

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
