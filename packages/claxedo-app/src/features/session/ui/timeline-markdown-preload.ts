import { preloadMarkdown } from "@/ui/session-kit"
import { useMarked } from "@opencode-ai/ui/context/marked"

type PreloadableConversation = {
  messages: Array<{ id: string }>
  parts: Record<string, Array<{ id: string; type: string; text?: string }> | undefined>
}

// Newest-first cap: enough to cover many screens of scrolling without idle-
// parsing a whole 400-turn transcript; deeper rows still parse on demand.
const preloadPartLimit = 200
const preloadSliceSize = 4

type PreloadJob = {
  collect: () => Array<{ id: string; text: string }> | undefined
  list?: Array<{ id: string; text: string }>
  index: number
  collectRetries: number
  parser: { parse(text: string): string | Promise<string> }
}

// ONE shared drain across every mounted timeline. Per-surface loops stacked:
// twenty sessions' preloads interleaving on forced idle-callback timeouts
// parsed continuously for tens of seconds and showed up as sustained
// double-digit app CPU while the app was supposedly quiescent. A single
// queue with deadline-aware slices bursts through the backlog when the page
// is truly idle and trickles to near-zero work under load.
const queue: PreloadJob[] = []
let draining = false

// Recency of USER INPUT, not page idleness: warm parses pay off exactly while
// the user is actively switching sessions (the CPU is busy anyway and the
// next switch needs the cache), and a machine left alone should go quiet —
// that is also precisely what "quiescent" means to anyone measuring us.
let lastInputAt = 0
const recentlyActive = () => performance.now() - lastInputAt < 5_000
if (typeof window !== "undefined") {
  const markInput = () => {
    lastInputAt = performance.now()
  }
  for (const name of ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"]) {
    window.addEventListener(name, markInput, { passive: true })
  }
}

const idle: (task: (deadline?: { timeRemaining(): number }) => void) => void =
  typeof requestIdleCallback === "function"
    ? // The timeout is a liveness backstop, not a pace-setter — but it IS the
      // tick ceiling under sustained load, so it follows the same activity
      // split as the slice budget: tight while the user works (warmth for
      // the next switch), long on a quiet page (near-zero quiescent cost).
      (task) => requestIdleCallback(task, { timeout: recentlyActive() ? 150 : 1_000 })
    : (task) => setTimeout(() => task(), 250)

const drain = async (deadline?: { timeRemaining(): number }) => {
  const job = queue[0]
  if (!job) {
    draining = false
    return
  }
  job.list ??= job.collect()
  if (job.list) {
    // Full slices while the user is actively working (recent input — the
    // next switch needs the cache warm) or while the tick is genuinely idle;
    // a forced tick on a quiet page parses one part to stay alive.
    const forced = deadline !== undefined && deadline.timeRemaining() < 4
    const budget = forced && !recentlyActive() ? 1 : preloadSliceSize
    const slice = job.list.slice(job.index, job.index + budget)
    job.index += budget
    for (const part of slice) {
      try {
        await preloadMarkdown(part.text, part.id, job.parser)
      } catch {
        // Preloading is opportunistic: the mounted row can retry through the
        // normal render path. One malformed block must not reject the idle
        // callback and strand every later job behind `draining = true`.
      }
    }
    if (job.index >= job.list.length) queue.shift()
  } else if (job.collectRetries++ > 40) {
    // The conversation never materialized; stop waiting for it.
    queue.shift()
  }
  idle(drain)
}

/**
 * Idle-parses a session's markdown so any timeline row that mounts — on any
 * visit, at any scroll position — renders its final HTML on the first paint.
 * Without this, a row whose blocks were never parsed paints the raw-text
 * fallback and then shifts when the async parse lands, which both jolts the
 * reader and poisons the virtualizer's persisted row measurements with the
 * fallback's height. `preloadMarkdown` skips blocks that are already cached,
 * so revisits and already-rendered rows cost a handful of map lookups.
 *
 * Jobs deliberately run to completion even if the surface unmounts: the
 * parsed HTML lands in the module-scope markdown cache, which is exactly
 * what a later remount of this session needs. Work is bounded per session by
 * `preloadPartLimit` and globally serialized by the shared queue.
 */
export function installTimelineMarkdownPreload(input: { conversation: () => PreloadableConversation | undefined }) {
  const parser = useMarked()
  // Bound the BACKLOG, not just the pace: a rapid sweep across many sessions
  // otherwise queues thousands of parts whose drain runs well past the last
  // input — the visible fold of every visited session already parsed during
  // its own visit, so only the most recent few sessions' off-screen rows are
  // worth finishing. Oldest pending jobs drop first.
  while (queue.length >= 3) queue.shift()
  queue.push({
    collect: () => {
      const conversation = input.conversation()
      if (!conversation) return undefined
      return conversation.messages
        .flatMap((message) => conversation.parts[message.id] ?? [])
        .flatMap((part) => (part.type === "text" && part.text ? [{ id: part.id, text: part.text }] : []))
        .slice(-preloadPartLimit)
        .reverse()
    },
    index: 0,
    collectRetries: 0,
    parser,
  })
  if (!draining) {
    draining = true
    idle(drain)
  }
}
