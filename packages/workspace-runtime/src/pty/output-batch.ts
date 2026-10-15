/**
 * A pty read returns whatever the kernel holds the moment the reader wakes, so
 * a reader that keeps up with a flooding program gets about 100 bytes per read
 * of `yes` on a 4-vCPU Linux sandbox. Everything a terminal does per chunk
 * (the emulator mirror, the history, one WebSocket frame through the relay to
 * the browser) is then paid per handful of bytes.
 *
 * The first read after a quiet window is delivered at once, so a keystroke's
 * echo waits for nothing. Reads arriving inside the window are joined and
 * delivered as one chunk when it closes or when the chunk reaches
 * OUTPUT_BATCH_MAX_CHARS, and a window that delivered something opens the next.
 */
export const OUTPUT_BATCH_WINDOW_MS = 4
/** The headless emulator parses at a steady rate up to 16 K per write and 30–55% slower at 64–256 K. */
export const OUTPUT_BATCH_MAX_CHARS = 16 * 1024

export type OutputBatch = {
  push(data: string): void
  /** Delivers what the open window holds now, so nothing pending is ordered after an exit. */
  flush(): void
}

export function createOutputBatch(
  deliver: (data: string) => void,
  limits: { windowMs: number; maxChars: number } = { windowMs: OUTPUT_BATCH_WINDOW_MS, maxChars: OUTPUT_BATCH_MAX_CHARS },
): OutputBatch {
  let pending: string[] = []
  let pendingChars = 0
  let window: ReturnType<typeof setTimeout> | undefined

  const take = () => {
    if (pending.length === 0) return undefined
    const data = pending.length === 1 ? pending[0] : pending.join("")
    pending = []
    pendingChars = 0
    return data
  }

  const flush = () => {
    const data = take()
    if (data !== undefined) deliver(data)
  }

  const close = () => {
    if (pending.length === 0) {
      window = undefined
      return
    }
    window = setTimeout(close, limits.windowMs)
    flush()
  }

  return {
    push(data) {
      if (!data) return
      if (!window) {
        window = setTimeout(close, limits.windowMs)
        deliver(data)
        return
      }
      pending.push(data)
      pendingChars += data.length
      if (pendingChars >= limits.maxChars) flush()
    },
    flush,
  }
}
