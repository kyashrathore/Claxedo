import type {
  WorkGraphMutationRequest,
  WorkGraphMutationResult,
  WorkGraphServiceRpc,
} from "@claxedo/service-contract/workgraph"
import type { FirstPartyServiceDescriptor } from "@claxedo/service-contract"

import { ServiceGatewayUnavailableError, requireEnabledService } from "./service-gateway"

/** Person-operation binding; deployment lifecycle RPC is deliberately a separate driver identity. */
export type WorkGraphServiceBinding = Pick<WorkGraphServiceRpc, "mutate">

export function createWorkGraphServiceGateway(input: {
  descriptor: FirstPartyServiceDescriptor | null
  binding?: WorkGraphServiceBinding
}) {
  return {
    async mutate(request: WorkGraphMutationRequest): Promise<WorkGraphMutationResult> {
      const descriptor = requireEnabledService(input.descriptor, "workgraph")
      if (!input.binding) throw new ServiceGatewayUnavailableError("workgraph", "binding_absent")
      const result = await input.binding.mutate(request)
      if (result.operationId !== request.operationId) {
        throw new ServiceGatewayUnavailableError(descriptor.serviceId, "response_mismatch")
      }
      return result
    },
  }
}
