import { RequestError, type AnyMessage, type CreateElicitationRequest, type JsonRpcId, type Stream } from "@agentclientprotocol/sdk"

export class AcpRequestScope {
  private readonly startup = new Set<JsonRpcId>()

  validate(request: CreateElicitationRequest): void {
    if (!("requestId" in request)) return
    const id = request.requestId
    if ((typeof id !== "string" && typeof id !== "number") || !this.startup.has(id)) {
      throw RequestError.invalidParams(undefined, "Elicitation does not belong to a pending ACP startup request")
    }
  }

  settle(message: AnyMessage): void {
    if (!("method" in message) && "id" in message) this.startup.delete(message.id)
  }

  writable(stream: Stream): Stream["writable"] {
    const writer = stream.writable.getWriter()
    return new WritableStream({
      write: async (message) => {
        const startup = "method" in message && (message.method === "initialize" || message.method === "session/new") && "id" in message
        if (startup) this.startup.add(message.id)
        try { await writer.write(message) }
        catch (error) { if (startup) this.startup.delete(message.id); throw error }
      },
      close: () => { this.startup.clear(); return writer.close() },
      abort: (reason) => { this.startup.clear(); return writer.abort(reason) },
    })
  }
}
