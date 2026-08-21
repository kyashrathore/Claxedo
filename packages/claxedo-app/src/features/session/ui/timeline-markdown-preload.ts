import { preloadMarkdown } from "@/ui/session-kit"
import { useMarked } from "@opencode-ai/ui/context/marked"

type PreloadableConversation = {
  messages: Array<{ id: string }>
  parts: Record<string, Array<{ id: string; type: string; text?: string }> | undefined>
}

// Newest-first cap: enough to cover many screens of scrolling without idle-
// parsing a whole 400-turn transcript; deeper rows still parse on demand.
const preloadPartLimit = 200
const preloadSliceSize = 8

// The timeout matters: without it Chrome can starve idle callbacks
// indefinitely while the user keeps interacting, which is exactly when the
// next session switch needs the cache warm.
const idle: (task: () => void) => void =
  typeof requestIdleCallback === "function"
    ? (task) => requestIdleCallback(() => task(), { timeout: 100 })
    : (task) => setTimeout(task, 50)

/**
 * Idle-parses a session's markdown so any timeline row that mounts — on any
 * visit, at any scroll position — renders its final HTML on the first paint.
 * Without this, a row whose blocks were never parsed paints the raw-text
 * fallback and then shifts when the async parse lands, which both jolts the
 * reader and poisons the virtualizer's persisted row measurements with the
 * fallback's height. `preloadMarkdown` skips blocks that are already cached,
 * so revisits and already-rendered rows cost nothing.
 *
 * The loop deliberately runs to completion even if the surface unmounts: the
 * parsed HTML lands in the module-scope markdown cache, which is exactly what
 * a later remount of this session needs. The work is bounded by
 * `preloadPartLimit` and each tick re-checks the cache, so an already-warm
 * session costs a handful of map lookups.
 */
export function installTimelineMarkdownPreload(input: {
  conversation: () => PreloadableConversation | undefined
}) {
  const parser = useMarked()
  let list: Array<{ id: string; text: string }> | undefined
  let index = 0
  const collect = () => {
    const conversation = input.conversation()
    if (!conversation) return undefined
    return conversation.messages
      .flatMap((message) => conversation.parts[message.id] ?? [])
      .flatMap((part) => (part.type === "text" && part.text ? [{ id: part.id, text: part.text }] : []))
      .slice(-preloadPartLimit)
      .reverse()
  }
  const tick = async () => {
    list ??= collect()
    if (!list) {
      idle(tick)
      return
    }
    const slice = list.slice(index, index + preloadSliceSize)
    index += preloadSliceSize
    for (const part of slice) await preloadMarkdown(part.text, part.id, parser)
    if (index < list.length) idle(tick)
  }
  idle(tick)
}
