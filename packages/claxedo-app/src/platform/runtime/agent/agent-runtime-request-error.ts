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
  const body = (() => {
    try {
      return JSON.parse(text) as { error?: { code?: unknown; message?: unknown } }
    } catch {
      return undefined
    }
  })()
  return new AgentRuntimeRequestError(
    typeof body?.error?.message === "string" ? body.error.message : text || `Request failed: ${res.status}`,
    res.status,
    typeof body?.error?.code === "string" ? body.error.code : undefined,
  )
}
