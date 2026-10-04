export type ServerSentEvent = { name: string; data: string }

function event(block: string): ServerSentEvent {
  const lines = block.split("\n")
  const name = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "message"
  const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")
  return { name, data }
}

/**
 * The events of a `text/event-stream` body, with lines ended by CRLF, CR or LF.
 * A CR that ends a chunk is held back, since the next chunk may start with its
 * LF. An event the stream ends without a blank line after is still read.
 */
export async function* serverSentEvents(body: ReadableStream<Uint8Array>): AsyncIterable<ServerSentEvent> {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffered = ""
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    const text = buffered + decoder.decode(chunk.value, { stream: true })
    const held = text.endsWith("\r") ? 1 : 0
    const blocks = text.slice(0, text.length - held).replace(/\r\n?/g, "\n").split("\n\n")
    buffered = blocks.pop()! + text.slice(text.length - held)
    for (const block of blocks) yield event(block)
  }
  const rest = (buffered + decoder.decode()).replace(/\r\n?/g, "\n").replace(/\n+$/, "")
  if (rest) yield event(rest)
}
