import { asRecord, asText } from "@claxedo/agent-runtime-contract"
import { jsonText } from "./value"

const EXCERPT_BYTES = 4096

export function frameExcerpt(payload: unknown) {
  const bytes = new TextEncoder().encode(jsonText(payload) || "null")
  const type = asText(asRecord(payload)?.type)
  return { ...(type ? { type } : {}), bytes: bytes.length, excerpt: new TextDecoder().decode(bytes.subarray(0, EXCERPT_BYTES)) }
}
