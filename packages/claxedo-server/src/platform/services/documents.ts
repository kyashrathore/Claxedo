import type { DocumentsJobReceipt, DocumentsJobRequest, DocumentsServiceRpc } from "@claxedo/service-contract/documents"
import type { FirstPartyServiceDescriptor } from "@claxedo/service-contract"

import { ServiceGatewayUnavailableError, requireEnabledService } from "./service-gateway"

/** Person-operation binding; deployment lifecycle RPC is deliberately a separate driver identity. */
export type DocumentsServiceBinding = Pick<DocumentsServiceRpc, "enqueue">

export function createDocumentsServiceGateway(input: {
  descriptor: FirstPartyServiceDescriptor | null
  binding?: DocumentsServiceBinding
}) {
  return {
    async enqueue(request: DocumentsJobRequest): Promise<DocumentsJobReceipt> {
      const descriptor = requireEnabledService(input.descriptor, "documents")
      if (!input.binding) throw new ServiceGatewayUnavailableError("documents", "binding_absent")
      const result = await input.binding.enqueue(request)
      if (result.operationId !== request.operationId) {
        throw new ServiceGatewayUnavailableError(descriptor.serviceId, "response_mismatch")
      }
      return result
    },
  }
}
