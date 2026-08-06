import type { LocalDiagnostics } from "@/features/processes/data/local-diagnostics"

type Bucket = "chatBytes" | "imageBytes" | "compactionBytes"

export function estimateConversationMemory(messages: readonly unknown[]): LocalDiagnostics.SessionMemoryBuckets {
  const buckets = { chatBytes: 0, imageBytes: 0, compactionBytes: 0 }
  estimate(messages, buckets, new WeakSet(), "chatBytes", false)
  return {
    ...buckets,
    totalBytes: buckets.chatBytes + buckets.imageBytes + buckets.compactionBytes,
  }
}

function estimate(
  value: unknown,
  buckets: Omit<LocalDiagnostics.SessionMemoryBuckets, "totalBytes">,
  seen: WeakSet<object>,
  bucket: Bucket,
  imageContext: boolean,
) {
  if (value === null) {
    buckets[bucket] += 4
    return
  }
  if (typeof value === "string") {
    buckets[imageString(value, imageContext) ? "imageBytes" : bucket] += utf8Bytes(value) + 2
    return
  }
  if (typeof value === "number") {
    buckets[bucket] += Number.isFinite(value) ? String(value).length : 4
    return
  }
  if (typeof value === "boolean") {
    buckets[bucket] += value ? 4 : 5
    return
  }
  if (typeof value !== "object") return
  if (seen.has(value)) return
  seen.add(value)
  if (value instanceof ArrayBuffer) {
    buckets[imageContext ? "imageBytes" : bucket] += value.byteLength
    return
  }
  if (ArrayBuffer.isView(value)) {
    buckets[imageContext ? "imageBytes" : bucket] += value.byteLength
    return
  }

  const nextBucket = record(value)?.type === "compaction" ? "compactionBytes" : bucket
  const nextImageContext = imageContext || imageRecord(value)
  if (Array.isArray(value)) {
    buckets[nextBucket] += 2 + Math.max(0, value.length - 1)
    value.forEach((item) => estimate(item, buckets, seen, nextBucket, nextImageContext))
    return
  }

  const entries = Object.entries(value)
  buckets[nextBucket] += 2 + Math.max(0, entries.length - 1)
  entries.forEach(([key, item]) => {
    buckets[nextBucket] += utf8Bytes(key) + 3
    estimate(item, buckets, seen, nextBucket, nextImageContext)
  })
}

function imageString(value: string, imageContext: boolean) {
  return value.startsWith("data:image/") || (imageContext && value.length > 256 && /^[A-Za-z0-9+/]+=*$/.test(value))
}

function imageRecord(value: object) {
  const item = record(value)
  if (!item) return false
  const mime = typeof item.mime === "string" ? item.mime : typeof item.media_type === "string" ? item.media_type : undefined
  return item.type === "image" || mime?.startsWith("image/") === true
}

function record(value: object) {
  return !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function utf8Bytes(value: string) {
  let size = 0
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 0x80) {
      size += 1
      continue
    }
    if (code < 0x800) {
      size += 2
      continue
    }
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        size += 4
        index += 1
        continue
      }
    }
    size += 3
  }
  return size
}
