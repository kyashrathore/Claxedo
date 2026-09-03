import { WorkerEntrypoint } from "cloudflare:workers"

import type { ServiceProbeRequest, ServiceProbeResponse } from "@claxedo/service-contract"
import type {
  DocumentsJobReceipt,
  DocumentsJobRequest,
  DocumentsServiceManagementRpc,
  DocumentsServiceRpc,
} from "@claxedo/service-contract/documents"

import { D1DocumentsServiceLifecycleStore } from "./d1-lifecycle"
import type { DocumentsServiceEnv } from "./env"
import { documentsServiceHttp } from "./http"
import { createDocumentsServiceRpc, type DocumentsServiceLifecycleInput } from "./service"

function lifecycleInput(env: DocumentsServiceEnv): DocumentsServiceLifecycleInput {
  if (env.CLAXEDO_DOCUMENTS_INITIAL_STATE !== "installed_disabled") {
    throw new Error("Documents service must be deployed initially disabled")
  }
  const identity = {
    environmentId: env.CLAXEDO_DOCUMENTS_ENVIRONMENT_ID,
    deploymentId: env.CLAXEDO_DOCUMENTS_DEPLOYMENT_ID,
    serviceBuildId: env.CLAXEDO_DOCUMENTS_SERVICE_BUILD_ID,
    bindingName: "DOCUMENTS_SERVICE" as const,
    entrypoint: "DocumentsServiceV1" as const,
    bindingProvenance: env.CLAXEDO_DOCUMENTS_BINDING_PROVENANCE,
  }
  const lifecycle = new D1DocumentsServiceLifecycleStore(env.DOCUMENTS_DB, identity)
  return {
    ...identity,
    lifecycle,
    lifecycleWriter: lifecycle,
  }
}

export class DocumentsServiceV1 extends WorkerEntrypoint<DocumentsServiceEnv> implements DocumentsServiceRpc {
  enqueue(request: DocumentsJobRequest): Promise<DocumentsJobReceipt> {
    return createDocumentsServiceRpc(lifecycleInput(this.env)).enqueue(request)
  }
}

export class DocumentsServiceManagementV1
  extends WorkerEntrypoint<DocumentsServiceEnv>
  implements DocumentsServiceManagementRpc
{
  applyLifecycle(request: Parameters<DocumentsServiceManagementRpc["applyLifecycle"]>[0]) {
    return createDocumentsServiceRpc(lifecycleInput(this.env)).applyLifecycle(request)
  }

  probe(request: ServiceProbeRequest): Promise<ServiceProbeResponse> {
    return createDocumentsServiceRpc(lifecycleInput(this.env)).probe(request)
  }
}

export default documentsServiceHttp satisfies ExportedHandler<DocumentsServiceEnv>
