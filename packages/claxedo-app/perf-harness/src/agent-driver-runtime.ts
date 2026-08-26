import { decodeDriverRequest, type AgentDriverRequest } from "./agent-driver-contract"

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
type JsonObject = { [key: string]: JsonValue }
type DriverMethod = AgentDriverRequest["method"]

export type AgentDriverResponse = {
  protocolVersion: 1
  kind: "response"
  correlationId: string
  method: DriverMethod
} & (
  | { ok: true; result: JsonValue }
  | { ok: false; error: { code: string; message: string; retriable: false } }
)

export type AgentDriverRuntimeDependencies = {
  hello(): JsonValue
  prepare(params: Extract<AgentDriverRequest, { method: "prepare" }>["params"]): Promise<JsonValue>
  launch(params: Extract<AgentDriverRequest, { method: "launch" }>["params"]): Promise<JsonValue>
  runScenario(params: Extract<AgentDriverRequest, { method: "run-scenario" }>["params"]): Promise<JsonValue>
  inspect(params: Extract<AgentDriverRequest, { method: "inspect" }>["params"]): Promise<JsonValue>
  shutdown(params: Extract<AgentDriverRequest, { method: "shutdown" }>["params"]): Promise<JsonValue>
}

type Lifecycle = "new" | "prepared" | "launched" | "shutdown"

export function createAgentDriverRuntime(dependencies: AgentDriverRuntimeDependencies) {
  let lifecycle: Lifecycle = "new"
  const correlationIds = new Set<string>()

  return {
    get lifecycle() {
      return lifecycle
    },
    async handle(line: string): Promise<AgentDriverResponse> {
      let request: AgentDriverRequest
      const fallback = envelopeFromInvalidLine(line)
      try {
        request = decodeDriverRequest(line)
      } catch (error) {
        return failure(fallback.correlationId, fallback.method, "invalid-request", error)
      }
      if (correlationIds.has(request.correlationId)) {
        return failure(
          request.correlationId,
          request.method,
          "duplicate-correlation-id",
          new Error("correlationId was already handled"),
        )
      }
      correlationIds.add(request.correlationId)

      try {
        if (request.method === "hello") return success(request.correlationId, request.method, dependencies.hello())
        if (request.method === "prepare") {
          requireLifecycle(lifecycle, ["new", "shutdown"], request.method)
          const result = await dependencies.prepare(request.params)
          lifecycle = "prepared"
          return success(request.correlationId, request.method, result)
        }
        if (request.method === "launch") {
          requireLifecycle(lifecycle, ["prepared"], request.method)
          const result = await dependencies.launch(request.params)
          lifecycle = "launched"
          return success(request.correlationId, request.method, result)
        }
        if (request.method === "run-scenario") {
          requireLifecycle(lifecycle, ["launched"], request.method)
          return success(request.correlationId, request.method, await dependencies.runScenario(request.params))
        }
        if (request.method === "inspect") {
          requireLifecycle(lifecycle, ["launched"], request.method)
          return success(request.correlationId, request.method, await dependencies.inspect(request.params))
        }
        requireLifecycle(lifecycle, ["prepared", "launched"], request.method)
        const result = await dependencies.shutdown(request.params)
        lifecycle = "shutdown"
        return success(request.correlationId, request.method, result)
      } catch (error) {
        return failure(
          request.correlationId,
          request.method,
          error instanceof LifecycleError ? "invalid-lifecycle" : "driver-failure",
          error,
        )
      }
    },
  }
}

class LifecycleError extends Error {}

function requireLifecycle(actual: Lifecycle, allowed: Lifecycle[], method: string) {
  if (allowed.includes(actual)) return
  throw new LifecycleError(`${method} is not allowed while driver is ${actual}`)
}

function success(correlationId: string, method: DriverMethod, result: JsonValue): AgentDriverResponse {
  return { protocolVersion: 1, kind: "response", correlationId, method, ok: true, result }
}

function failure(correlationId: string, method: DriverMethod, code: string, error: unknown): AgentDriverResponse {
  const message = error instanceof Error ? error.message : String(error)
  return {
    protocolVersion: 1,
    kind: "response",
    correlationId,
    method,
    ok: false,
    error: { code, message: message.slice(0, 1_024), retriable: false },
  }
}

function envelopeFromInvalidLine(line: string): { correlationId: string; method: DriverMethod } {
  try {
    const value = JSON.parse(line) as JsonObject
    const correlationId = typeof value?.correlationId === "string" && value.correlationId.length <= 256
      ? value.correlationId
      : "invalid"
    const method = typeof value?.method === "string" && isMethod(value.method) ? value.method : "hello"
    return { correlationId, method }
  } catch {
    return { correlationId: "invalid", method: "hello" }
  }
}

function isMethod(value: string): value is DriverMethod {
  return ["hello", "prepare", "launch", "run-scenario", "inspect", "shutdown"].includes(value)
}
