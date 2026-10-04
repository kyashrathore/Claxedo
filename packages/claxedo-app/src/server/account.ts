import { decodeHostedResult, type DecodedHostedResult, type HostedOperationName, type RunHostedOperation } from "@claxedo/account-contract"
import { hostedOperationError, ServerError } from "./errors"
import { hostedOperationRequest, sendHostedRequest } from "./operations"
import type { Transport } from "./transport"

export type HostedAccount = {
  readonly run: <N extends HostedOperationName>(operation: N, input?: Readonly<Record<string, unknown>>) => Promise<DecodedHostedResult<N>>
}

function decodeHostedAnswer<N extends HostedOperationName>(operation: N, raw: unknown): DecodedHostedResult<N> {
  try {
    return decodeHostedResult(operation, raw)
  } catch (error) {
    throw new ServerError({ class: "internal", message: error instanceof Error ? error.message : String(error), cause: error })
  }
}

export function createBrowserHostedAccount(transport: Transport): HostedAccount {
  return { run: async (operation, input) => decodeHostedAnswer(operation, await sendHostedRequest(transport, hostedOperationRequest(operation, input, "renderer"))) }
}

export function createHostedAccount(run: RunHostedOperation): HostedAccount {
  return {
    run: async (operation, input) => {
      let raw: unknown
      try {
        raw = await run(operation, input)
      } catch (error) {
        throw hostedOperationError(operation, error)
      }
      return decodeHostedAnswer(operation, raw)
    },
  }
}
