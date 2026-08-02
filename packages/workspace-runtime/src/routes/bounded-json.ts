export async function boundedJson(request: Request, maxBytes: number) {
  const declared = Number(request.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maxBytes) throw new RequestBodyTooLargeError()
  if (!request.body) throw new Error("Request body is required")
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    total += chunk.value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new RequestBodyTooLargeError()
    }
    chunks.push(chunk.value)
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result)) as unknown
}

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body is too large")
  }
}
