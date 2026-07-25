import { safeStartIndex, safeTrimStart } from "./safe-slice"

export function createHistory(limit: number) {
  const chunks: string[] = []
  let total = 0

  const clamp = (value: number) => {
    if (!Number.isFinite(value)) return 0
    return Math.max(0, Math.floor(value))
  }

  const trim = () => {
    let excess = total - limit
    if (excess <= 0) return
    while (excess > 0 && chunks.length > 0) {
      const head = chunks[0]
      if (!head) break
      if (head.length <= excess) {
        chunks.shift()
        total -= head.length
        excess -= head.length
        continue
      }
      // Cut on a safe boundary — a raw slice can leave the retained history
      // starting mid-escape (xterm prints the tail literally) or on a lone
      // surrogate. `cut` may exceed `excess`, so account for what we removed.
      const cut = safeStartIndex(head, excess)
      chunks[0] = head.slice(cut)
      total -= cut
      excess = 0
    }
  }

  return {
    append(data: string) {
      if (!data) return
      if (limit <= 0) return
      chunks.push(data)
      total += data.length
      trim()
    },
    snapshot(max?: number) {
      if (!chunks.length) return ""
      const cap = clamp(max ?? limit)
      if (cap <= 0) return ""
      const joined = chunks.join("")
      if (joined.length <= cap) return joined
      // The snapshot is what a cold-restored terminal replays, so its head must
      // not start mid-escape — that is the junk-at-top-of-scrollback failure.
      return safeTrimStart(joined, cap)
    },
    clear() {
      chunks.length = 0
      total = 0
    },
    size() {
      return total
    },
  }
}
