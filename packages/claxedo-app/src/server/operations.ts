import { asString } from "@claxedo/helpers/guards"
import { isHostedOperationName, type HostedOperationName } from "@claxedo/account-contract"
import type { HostedAccount } from "./account"
import { ServerError } from "./errors"
import { withQuery, type Transport } from "./transport"

type Input = Readonly<Record<string, unknown>>

type OperationRequest = {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  readonly path: string
  readonly query?: Readonly<Record<string, string | undefined>>
  readonly body?: Input
  readonly ifMatch?: string
}

const DOCUMENTS = "/documents"

function operationInputError(operation: string, message: string): ServerError {
  return new ServerError({ class: "invalid", message: `${operation}: ${message}` })
}

function inputOf(operation: string, value: unknown): Input {
  if (value === undefined) return {}
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Input
  throw operationInputError(operation, "the input is not an object")
}

function requiredTextField(operation: string, input: Input, key: string): string {
  const value = input[key]
  if (typeof value === "string" && value.length > 0) return value
  throw operationInputError(operation, `${key} is required`)
}

function omitFields(input: Input, ...keys: readonly string[]): Input {
  return Object.fromEntries(Object.entries(input).filter(([key]) => !keys.includes(key)))
}

function documentPath(operation: string, input: Input, ...rest: readonly string[]): string {
  return [DOCUMENTS, requiredTextField(operation, input, "id"), ...rest].map((segment, index) => (index === 0 ? segment : encodeURIComponent(segment))).join("/")
}

function scopeQuery(input: Input): OperationRequest["query"] {
  return {
    project_id: asString(input.project_id),
    document_id: asString(input.document_id),
    directory: asString(input.directory),
    archived: asString(input.archived),
  }
}

type Operation = (name: string, input: Input) => OperationRequest

const OPERATIONS: Readonly<Partial<Record<HostedOperationName, Operation>>> = {
  "org.invitations.create": (name, input) => ({ method: "POST", path: `/api/control/orgs/${encodeURIComponent(requiredTextField(name, input, "orgId"))}/invitations`, body: { email: requiredTextField(name, input, "email"), role: requiredTextField(name, input, "role") } }),
  "org.invitations.list": (name, input) => ({ method: "GET", path: `/api/control/orgs/${encodeURIComponent(requiredTextField(name, input, "orgId"))}/invitations` }),
  "org.invitations.revoke": (name, input) => ({ method: "DELETE", path: `/api/control/orgs/${encodeURIComponent(requiredTextField(name, input, "orgId"))}/invitations/${encodeURIComponent(requiredTextField(name, input, "invitationId"))}` }),
  "org.invitations.accept": (name, input) => ({ method: "POST", path: "/api/control/invitations/accept", body: { token: requiredTextField(name, input, "token") } }),
  "documents.list": (_name, input) => ({ method: "GET", path: DOCUMENTS, query: scopeQuery(input) }),
  "documents.statuses": (_name, input) => ({ method: "GET", path: `${DOCUMENTS}/statuses`, query: scopeQuery(input) }),
  "documents.get": (name, input) => ({ method: "GET", path: documentPath(name, input) }),
  "documents.create": (_name, input) => ({ method: "POST", path: DOCUMENTS, body: input }),
  "documents.fromRepo": (_name, input) => ({ method: "POST", path: `${DOCUMENTS}/from-repo`, body: input }),
  "documents.update": (name, input) => ({ method: "PATCH", path: documentPath(name, input), body: omitFields(input, "id", "ifMatch"), ifMatch: asString(input.ifMatch) }),
  "documents.content.get": (name, input) => ({ method: "GET", path: documentPath(name, input, "content") }),
  "documents.content.put": (name, input) => ({ method: "PUT", path: documentPath(name, input, "content"), body: omitFields(input, "id", "ifMatch"), ifMatch: requiredTextField(name, input, "ifMatch") }),
  "documents.snapshots": (name, input) => ({ method: "GET", path: documentPath(name, input, "snapshots") }),
  "documents.snapshots.restore": (name, input) => ({ method: "POST", path: documentPath(name, input, "snapshots", requiredTextField(name, input, "snapshotId"), "restore"), body: {}, ifMatch: requiredTextField(name, input, "ifMatch") }),
  "documents.agentOpen": (name, input) => ({ method: "POST", path: documentPath(name, input, "agent-open"), body: omitFields(input, "id") }),
  "documents.runtimeConflictResolve": (name, input) => ({ method: "POST", path: documentPath(name, input, "runtime-conflict", "resolve"), body: omitFields(input, "id") }),
  "documents.moveToRepository": (name, input) => ({ method: "POST", path: documentPath(name, input, "move-to-repository"), body: omitFields(input, "id") }),
}

export type Operations = { readonly run: (name: string, input: unknown) => Promise<unknown> }

export function hostedOperationRequest(name: string, input: unknown): OperationRequest {
  const operation = isHostedOperationName(name) ? OPERATIONS[name] : undefined
  if (!operation) throw operationInputError(name, "this server offers no such operation to the app")
  return operation(name, inputOf(name, input))
}

function onServer(transport: Transport): Operations["run"] {
  return (name, input) => {
    const request = hostedOperationRequest(name, input)
    return transport.json<unknown>(request.query ? withQuery(request.path, request.query) : request.path, {
      method: request.method,
      ...(request.ifMatch ? { headers: { "If-Match": request.ifMatch } } : {}),
      ...(request.body ? { body: JSON.stringify(request.body) } : {}),
    })
  }
}

function onAccount(account: HostedAccount): Operations["run"] {
  return async (name, input) => {
    hostedOperationRequest(name, input)
    if (!isHostedOperationName(name)) throw operationInputError(name, "this server offers no such operation to the app")
    return account.run(name, inputOf(name, input))
  }
}

export function createOperations(transport: Transport, account: HostedAccount | undefined): Operations {
  return { run: account ? onAccount(account) : onServer(transport) }
}
