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

const idle: (task: (deadline?: { timeRemaining(): number }) => void) => void =
  typeof requestIdleCallback === "function"
    ? // The long timeout is a liveness backstop, not a pace-setter: when the
      // page idles, callbacks fire every frame and the backlog drains in a
      // few seconds; when the user is active, forced ticks land rarely and
      // each does minimal work (see the deadline check below).
      (task) => requestIdleCallback(task, { timeout: 1_000 })
    : (task) => setTimeout(() => task(), 250)

const drain = async (deadline?: { timeRemaining(): number }) => {
  const job = queue[0]
  if (!job) {
    draining = false
    return
  }
  job.list ??= job.collect()
  if (job.list) {
    // A forced (deadline-exhausted) tick parses one part to stay alive; a
    // genuinely idle tick takes a full slice.
    const budget = deadline && deadline.timeRemaining() < 4 ? 1 : preloadSliceSize
    const slice = job.list.slice(job.index, job.index + budget)
    job.index += budget
    for (const part of slice) await preloadMarkdown(part.text, part.id, job.parser)
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
export function installTimelineMarkdownPreload(input: {
  conversation: () => PreloadableConversation | undefined
}) {
  const parser = useMarked()
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
