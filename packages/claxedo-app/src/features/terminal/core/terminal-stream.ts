export type Stream = {
  items: string[]
  bytes: number
  dropped: number
}

const encoder = new TextEncoder()

function utf8Bytes(data: string) {
  return encoder.encode(data).byteLength
}

function takeBytePrefix(data: string, maxBytes: number) {
  if (maxBytes <= 0) return { value: "", rest: data, bytes: 0 }

  let bytes = 0
  let end = 0
  for (const char of data) {
    const charBytes = utf8Bytes(char)
    if (bytes + charBytes > maxBytes) break
    bytes += charBytes
    end += char.length
  }
  return {
    value: data.slice(0, end),
    rest: data.slice(end),
    bytes,
  }
}

export function capChunk(data: string, maxBytes: number) {
  const bytes = utf8Bytes(data)
  if (bytes <= maxBytes) return { value: data, bytes, trimmed: false }

  let nextBytes = 0
  const suffix: string[] = []
  for (const char of Array.from(data).reverse()) {
    const charBytes = utf8Bytes(char)
    if (nextBytes + charBytes > maxBytes) break
    suffix.push(char)
    nextBytes += charBytes
  }
  suffix.reverse()
  return { value: suffix.join(""), bytes: nextBytes, trimmed: true }
}

export function createStream() {
  return {
    items: [],
    bytes: 0,
    dropped: 0,
  } satisfies Stream
}

export function pushStream(stream: Stream, data: string, maxBytes: number) {
  const next = capChunk(data, maxBytes)
  if (next.trimmed) stream.dropped += 1
  if (!next.value) return

  stream.items.push(next.value)
  stream.bytes += next.bytes

  while (stream.bytes > maxBytes && stream.items.length > 1) {
    const next = stream.items.shift()
    if (!next) break
    stream.bytes -= utf8Bytes(next)
    stream.dropped += 1
  }
}

export function takeStream(stream: Stream, maxBytes: number, maxItems: number) {
  if (stream.items.length === 0) return ""
  if (maxBytes <= 0 || maxItems <= 0) return ""
  let bytes = 0
  let count = 0
  let out = ""

  while (stream.items.length > 0 && count < maxItems) {
    const next = stream.items[0]
    if (!next) break
    const nextBytes = utf8Bytes(next)
    if (count > 0 && bytes + nextBytes > maxBytes) break
    if (nextBytes > maxBytes - bytes) {
      const chunk = takeBytePrefix(next, maxBytes - bytes)
      if (!chunk.value) break
      if (chunk.rest) stream.items[0] = chunk.rest
      else stream.items.shift()
      stream.bytes -= chunk.bytes
      out += chunk.value
      bytes += chunk.bytes
      count += 1
      break
    }
    stream.items.shift()
    stream.bytes -= nextBytes
    out += next
    bytes += nextBytes
    count += 1
    if (bytes >= maxBytes) break
  }

  return out
}
