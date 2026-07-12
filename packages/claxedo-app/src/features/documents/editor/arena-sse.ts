// Incremental Server-Sent-Events framing for the Arena stream. The transport
// (fetch + ReadableStream + TextDecoder) stays in the component; this module
// owns the pure string work of turning a byte-boundary-agnostic char stream
// into whole `data:` payloads, so the framing can be tested across chunk
// splits without a live stream.

/**
 * Join the `data:` lines of a single SSE frame into its payload string,
 * stripping the `data:` prefix and one leading space per line. Non-data lines
 * (comments, `event:`, blank) are dropped. Multi-line data is newline-joined.
 */
export function extractSseData(frame: string): string {
  return frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
}

export type ArenaSseParser = {
  /**
   * Feed a decoded text chunk. Returns the payloads of every frame completed by
   * this chunk (a frame ends at a blank line, i.e. `\n\n`). Empty payloads are
   * dropped. A trailing partial frame is buffered until a later chunk finishes it.
   */
  push(chunk: string): string[]
}

export function createArenaSseParser(): ArenaSseParser {
  let buffer = ""
  return {
    push(chunk: string): string[] {
      buffer += chunk
      const frames = buffer.split("\n\n")
      buffer = frames.pop() ?? ""
      return frames.map(extractSseData).filter((data) => data.length > 0)
    },
  }
}
