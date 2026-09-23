import { readField, readString } from "@/lib/record"
export class AgentRuntimeRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = "AgentRuntimeRequestError"
  }
}

export async function runtimeRequestError(res: Response) {
  const text = await res.text()
  const error = ((): unknown => {
    try {
      return readField(JSON.parse(text), "error")
    } catch {
      return undefined
    }
  })()
  return new AgentRuntimeRequestError(
    readString(error, "message") ?? (text || `Request failed: ${res.status}`),
    res.status,
    readString(error, "code"),
  )
}
