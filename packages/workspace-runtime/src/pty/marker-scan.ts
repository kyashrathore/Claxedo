/**
 * Scanning the PTY stream for a fixed marker that may straddle chunk boundaries.
 *
 * PTY reads are cut at kernel buffer boundaries with no regard for content, so
 * any `data.includes(MARKER)` check on a single chunk misses a marker split
 * across two reads. We already carry a tail for OSC-7 and for DECSET modes; the
 * shell-ready marker and the clear-scrollback sequence were the two scanners
 * that never got the same treatment, so both fired only when the marker
 * happened to land inside one read.
 *
 * The carry is bounded at `needle.length - 1` — the longest prefix that can
 * still become a match — so this cannot grow with stream volume.
 */
export function createMarkerScanner(needle: string) {
  if (!needle) throw new Error("createMarkerScanner: needle must be non-empty")
  const carryMax = needle.length - 1
  let carry = ""

  return {
    /**
     * Feed a chunk. Returns true when the marker completes in this chunk —
     * including when it began in an earlier one.
     */
    scan(chunk: string): boolean {
      if (!chunk) return false
      const combined = carry + chunk
      const hit = combined.includes(needle)
      // Retain only what could still be the head of a future match. When we
      // just matched there is nothing pending, so start clean.
      carry = hit ? "" : combined.slice(Math.max(0, combined.length - carryMax))
      return hit
    },

    /** Drop pending state (session reset / marker no longer of interest). */
    reset() {
      carry = ""
    },
  }
}

export type MarkerScanner = ReturnType<typeof createMarkerScanner>
