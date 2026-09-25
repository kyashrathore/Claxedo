import { ServerError } from "./errors"
import { withQuery, type Transport } from "./transport"

type Input = Readonly<Record<string, unknown>>

type OperationRequest = {
  readonly method: "GET" | "POST" | "PUT" | "PATCH"
  readonly path: string
  readonly query?: Readonly<Record<string, string | undefined>>
  readonly body?: Input
  readonly ifMatch?: string
}

const DOCUMENTS = "/documents"

function invalid(operation: string, message: string): ServerError {
  return new ServerError({ class: "invalid", message: `${operation}: ${message}` })
}

function inputOf(operation: string, value: unknown): Input {
  if (value === undefined) return {}
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Input
  throw invalid(operation, "the input is not an object")
}

function text(operation: string, input: Input, key: string): string {
  const value = input[key]
  if (typeof value === "string" && value.length > 0) return value
  throw invalid(operation, `${key} is required`)
}

function optionalText(input: Input, key: string): string | undefined {
  const value = input[key]
  return typeof value === "string" ? value : undefined
}

function without(input: Input, ...keys: readonly string[]): Input {
  return Object.fromEntries(Object.entries(input).filter(([key]) => !keys.includes(key)))
}

function documentPath(operation: string, input: Input, ...rest: readonly string[]): string {
  return [DOCUMENTS, text(operation, input, "id"), ...rest].map((segment, index) => (index === 0 ? segment : encodeURIComponent(segment))).join("/")
}

function scopeQuery(input: Input): OperationRequest["query"] {
  return {
    project_id: optionalText(input, "project_id"),
    document_id: optionalText(input, "document_id"),
    directory: optionalText(input, "directory"),
    archived: optionalText(input, "archived"),
  }
}

type Operation = (name: string, input: Input) => OperationRequest

const OPERATIONS: Readonly<Record<string, Operation>> = {
  "documents.list": (_name, input) => ({ method: "GET", path: DOCUMENTS, query: scopeQuery(input) }),
  "documents.statuses": (_name, input) => ({ method: "GET", path: `${DOCUMENTS}/statuses`, query: scopeQuery(input) }),
  "documents.get": (name, input) => ({ method: "GET", path: documentPath(name, input) }),
  "documents.create": (_name, input) => ({ method: "POST", path: DOCUMENTS, body: input }),
  "documents.fromRepo": (_name, input) => ({ method: "POST", path: `${DOCUMENTS}/from-repo`, body: input }),
  "documents.update": (name, input) => ({ method: "PATCH", path: documentPath(name, input), body: without(input, "id", "ifMatch"), ifMatch: optionalText(input, "ifMatch") }),
  "documents.content.get": (name, input) => ({ method: "GET", path: documentPath(name, input, "content") }),
  "documents.content.put": (name, input) => ({ method: "PUT", path: documentPath(name, input, "content"), body: without(input, "id", "ifMatch"), ifMatch: text(name, input, "ifMatch") }),
  "documents.snapshots": (name, input) => ({ method: "GET", path: documentPath(name, input, "snapshots") }),
  "documents.snapshots.restore": (name, input) => ({ method: "POST", path: documentPath(name, input, "snapshots", text(name, input, "snapshotId"), "restore"), body: {}, ifMatch: text(name, input, "ifMatch") }),
  "documents.agentOpen": (name, input) => ({ method: "POST", path: documentPath(name, input, "agent-open"), body: without(input, "id") }),
  "documents.runtimeConflictResolve": (name, input) => ({ method: "POST", path: documentPath(name, input, "runtime-conflict", "resolve"), body: without(input, "id") }),
  "documents.moveToRepository": (name, input) => ({ method: "POST", path: documentPath(name, input, "move-to-repository"), body: without(input, "id") }),
}

export type Operations = { readonly run: (name: string, input: unknown) => Promise<unknown> }

export function operationRequest(name: string, input: unknown): OperationRequest {
  const operation = OPERATIONS[name]
  if (!operation) throw invalid(name, "this server offers no such operation to the app")
  return operation(name, inputOf(name, input))
}

export function createOperations(transport: Transport): Operations {
  return {
    run: (name, input) => {
      const request = operationRequest(name, input)
      return transport.json<unknown>(request.query ? withQuery(request.path, request.query) : request.path, {
        method: request.method,
        ...(request.ifMatch ? { headers: { "If-Match": request.ifMatch } } : {}),
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      })
    },
  }
}
