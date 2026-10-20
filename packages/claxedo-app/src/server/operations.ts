import { hostedOperationTable, type ResolvedRequest, type RunHostedOperation } from "@claxedo/account-contract"
import { DOCUMENTS_OPERATIONS } from "@claxedo/documents/operations"
import { isRecord } from "@claxedo/helpers/guards"
import type { HostedAccount } from "./account"
import { ServerError } from "./errors"
import type { Transport } from "./transport"

type Input = Readonly<Record<string, unknown>>

export const APP_HOSTED_OPERATIONS = hostedOperationTable(DOCUMENTS_OPERATIONS)
export type AppHostedOperations = typeof APP_HOSTED_OPERATIONS.operations
export type RunAppHostedOperation = RunHostedOperation<AppHostedOperations>

function operationInputError(operation: string, message: string): ServerError {
  return new ServerError({ class: "invalid", message: `${operation}: ${message}` })
}

function inputOf(operation: string, value: unknown): Input {
  if (value === undefined) return {}
  if (isRecord(value)) return value
  throw operationInputError(operation, "the input is not an object")
}

export type Operations = { readonly run: (name: string, input: unknown) => Promise<unknown> }

export function hostedOperationRequest(name: string, input: unknown, exposure: "app" | "renderer"): ResolvedRequest {
  if (!APP_HOSTED_OPERATIONS.has(name) || !APP_HOSTED_OPERATIONS.operations[name].exposure[exposure]) {
    throw operationInputError(name, "this server offers no such operation to the app")
  }
  try {
    return APP_HOSTED_OPERATIONS.resolve(name, input)
  } catch (error) {
    throw operationInputError(name, error instanceof Error ? error.message : String(error))
  }
}

export function sendHostedRequest(transport: Transport, request: ResolvedRequest): Promise<unknown> {
  return transport.json(request.path, {
    method: request.method,
    ...(request.headers ? { headers: request.headers } : {}),
    ...(request.body ? { body: JSON.stringify(request.body) } : {}),
  })
}

function onServer(transport: Transport): Operations["run"] {
  return (name, input) => sendHostedRequest(transport, hostedOperationRequest(name, input, "app"))
}

function onAccount(account: HostedAccount): Operations["run"] {
  return async (name, input) => {
    hostedOperationRequest(name, input, "app")
    if (!APP_HOSTED_OPERATIONS.has(name)) throw operationInputError(name, "this server offers no such operation to the app")
    return account.run(name, inputOf(name, input))
  }
}

export function createOperations(transport: Transport, account: HostedAccount | undefined): Operations {
  return { run: account ? onAccount(account) : onServer(transport) }
}
