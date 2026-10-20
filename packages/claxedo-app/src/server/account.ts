import type { DecodedHostedResult, HostedOperationName } from "@claxedo/account-contract"
import { hostedOperationError, ServerError } from "./errors"
import { APP_HOSTED_OPERATIONS, hostedOperationRequest, sendHostedRequest, type AppHostedOperations, type RunAppHostedOperation } from "./operations"
import type { Transport } from "./transport"

export type HostedAccount = {
  readonly run: <N extends HostedOperationName<AppHostedOperations>>(operation: N, input?: Readonly<Record<string, unknown>>) => Promise<DecodedHostedResult<N, AppHostedOperations>>
}

function decodeHostedAnswer<N extends HostedOperationName<AppHostedOperations>>(operation: N, raw: unknown): DecodedHostedResult<N, AppHostedOperations> {
  try {
    return APP_HOSTED_OPERATIONS.decode(operation, raw)
  } catch (error) {
    throw new ServerError({ class: "internal", message: error instanceof Error ? error.message : String(error), cause: error })
  }
}

export function createBrowserHostedAccount(transport: Transport): HostedAccount {
  return { run: async (operation, input) => decodeHostedAnswer(operation, await sendHostedRequest(transport, hostedOperationRequest(operation, input, "renderer"))) }
}

export function createHostedAccount(run: RunAppHostedOperation): HostedAccount {
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
