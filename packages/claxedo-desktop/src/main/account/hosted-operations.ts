import { hostedOperationNames, type HostedOperationName } from "@claxedo/account-contract"

export {
  HOSTED_OPERATIONS, resolveHostedOperation, isHostedOperationName, isStreamHostedOperation,
  MissingOperationParameter, UnknownHostedOperation,
  type HostedOperationName, type ResolvedRequest,
} from "@claxedo/account-contract"

export const HOSTED_OPERATION_NAMES = hostedOperationNames()

export function hostedOperationChannel(name: HostedOperationName) {
  return `claxedo.account.operation:${name}`
}
