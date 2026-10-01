import { HOSTED_OPERATIONS, isHostedOperationName, resolveHostedOperation, type ResolvedRequest } from "@claxedo/account-contract"
import type { HostedAccount } from "./account"
import { ServerError } from "./errors"
import type { Transport } from "./transport"

type Input = Readonly<Record<string, unknown>>

function operationInputError(operation: string, message: string): ServerError {
  return new ServerError({ class: "invalid", message: `${operation}: ${message}` })
}

function inputOf(operation: string, value: unknown): Input {
  if (value === undefined) return {}
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Input
  throw operationInputError(operation, "the input is not an object")
}

export type Operations = { readonly run: (name: string, input: unknown) => Promise<unknown> }

export function hostedOperationRequest(name: string, input: unknown): ResolvedRequest {
  if (!isHostedOperationName(name) || !HOSTED_OPERATIONS[name].exposure.app) {
    throw operationInputError(name, "this server offers no such operation to the app")
  }
  try {
    return resolveHostedOperation(name, input)
  } catch (error) {
    throw operationInputError(name, error instanceof Error ? error.message : String(error))
  }
}

function onServer(transport: Transport): Operations["run"] {
  return (name, input) => {
    const request = hostedOperationRequest(name, input)
    return transport.json<unknown>(request.path, {
      method: request.method,
      ...(request.headers ? { headers: request.headers } : {}),
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
