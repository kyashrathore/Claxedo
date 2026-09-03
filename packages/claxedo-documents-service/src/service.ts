import {
  SERVICE_BINDINGS,
  SERVICE_PROTOCOL_VERSION,
  requireServiceLifecycleMutationRequest,
  type ServiceLifecycleMutationRequest,
  type ServiceLifecycleMutationResponse,
  type ServiceLocalLifecycleState,
  type ServiceProbeRequest,
} from "@claxedo/service-contract"
import type {
  DocumentsJobReceipt,
  DocumentsJobRequest,
  DocumentsServiceManagementRpc,
  DocumentsServiceRpc,
} from "@claxedo/service-contract/documents"

import { DOCUMENTS_SERVICE_ENTRYPOINT, DOCUMENTS_SERVICE_SCHEMA_VERSION } from "./constants"

export type DocumentsServiceLifecycle = Readonly<{
  environmentId: string
  deploymentId: string
  serviceBuildId: string
  state: ServiceLocalLifecycleState
  revision: number
}>

export interface DocumentsServiceLifecycleReader {
  read(): Promise<DocumentsServiceLifecycle | undefined>
}

export interface DocumentsServiceLifecycleWriter {
  apply(request: ServiceLifecycleMutationRequest): Promise<ServiceLifecycleMutationResponse>
}

export class DocumentsServiceLifecycleError extends Error {
  constructor(
    public readonly code:
      | "invalid_request"
      | "protocol_mismatch"
      | "installation_mismatch"
      | "lifecycle_uninitialized"
      | "lifecycle_mismatch"
      | "service_disabled"
      | "runtime_unavailable",
    message: string,
  ) {
    super(message)
    this.name = "DocumentsServiceLifecycleError"
  }
}

export type DocumentsServiceLifecycleInput = Readonly<{
  environmentId: string
  deploymentId: string
  serviceBuildId: string
  bindingName: typeof SERVICE_BINDINGS.documents
  entrypoint: typeof DOCUMENTS_SERVICE_ENTRYPOINT
  bindingProvenance: string
  lifecycle: DocumentsServiceLifecycleReader
  lifecycleWriter?: DocumentsServiceLifecycleWriter
}>

export interface DocumentsServiceRuntime {
  probe(): Promise<void>
  enqueue(request: DocumentsJobRequest): Promise<DocumentsJobReceipt>
}

type DocumentsServiceRpcInput = DocumentsServiceLifecycleInput &
  Readonly<{
    runtime?: DocumentsServiceRuntime
  }>

function requireConfiguredText(value: string, name: string) {
  if (!value || value.trim() !== value) {
    throw new DocumentsServiceLifecycleError("lifecycle_mismatch", `${name} is not canonical`)
  }
  return value
}

function requireProbeRequest(request: ServiceProbeRequest, input: DocumentsServiceRpcInput) {
  if (request.protocolVersion !== SERVICE_PROTOCOL_VERSION) {
    throw new DocumentsServiceLifecycleError("protocol_mismatch", "Documents service protocol does not match")
  }
  if (!Number.isSafeInteger(request.installationRevision) || request.installationRevision <= 0) {
    throw new DocumentsServiceLifecycleError("invalid_request", "installationRevision must be a positive safe integer")
  }
  if (request.environmentId !== input.environmentId || request.deploymentId !== input.deploymentId) {
    throw new DocumentsServiceLifecycleError("installation_mismatch", "Documents probe targets another installation")
  }
}

export async function readDocumentsServiceLifecycle(input: DocumentsServiceLifecycleInput) {
  requireConfiguredText(input.environmentId, "environmentId")
  requireConfiguredText(input.deploymentId, "deploymentId")
  requireConfiguredText(input.serviceBuildId, "serviceBuildId")
  requireConfiguredText(input.bindingProvenance, "bindingProvenance")
  const lifecycle = await input.lifecycle.read()
  if (!lifecycle) return undefined
  if (
    lifecycle.environmentId !== input.environmentId ||
    lifecycle.deploymentId !== input.deploymentId ||
    lifecycle.serviceBuildId !== input.serviceBuildId ||
    !Number.isSafeInteger(lifecycle.revision) ||
    lifecycle.revision <= 0
  ) {
    throw new DocumentsServiceLifecycleError("lifecycle_mismatch", "Documents lifecycle does not match its deployment")
  }
  return lifecycle
}

async function requireLifecycle(input: DocumentsServiceLifecycleInput) {
  const lifecycle = await readDocumentsServiceLifecycle(input)
  if (!lifecycle) {
    throw new DocumentsServiceLifecycleError("lifecycle_uninitialized", "Documents service lifecycle is uninitialized")
  }
  return lifecycle
}

function requireRuntime(input: DocumentsServiceRpcInput) {
  if (!input.runtime) {
    throw new DocumentsServiceLifecycleError(
      "runtime_unavailable",
      "Documents grant verifier, D1 job/idempotency adapter, and R2 revision runtime are not installed",
    )
  }
  return input.runtime
}

export function createDocumentsServiceRpc(
  input: DocumentsServiceRpcInput,
): DocumentsServiceRpc & DocumentsServiceManagementRpc {
  requireConfiguredText(input.environmentId, "environmentId")
  requireConfiguredText(input.deploymentId, "deploymentId")
  requireConfiguredText(input.serviceBuildId, "serviceBuildId")
  requireConfiguredText(input.bindingProvenance, "bindingProvenance")
  if (input.bindingName !== SERVICE_BINDINGS.documents || input.entrypoint !== DOCUMENTS_SERVICE_ENTRYPOINT) {
    throw new DocumentsServiceLifecycleError("lifecycle_mismatch", "Documents binding identity is not canonical")
  }
  return {
    async applyLifecycle(rawRequest) {
      const request = requireServiceLifecycleMutationRequest(rawRequest)
      if (
        request.serviceId !== "documents" ||
        request.identity.environmentId !== input.environmentId ||
        request.identity.deploymentId !== input.deploymentId ||
        request.protocolVersion !== SERVICE_PROTOCOL_VERSION ||
        request.schemaVersion !== DOCUMENTS_SERVICE_SCHEMA_VERSION ||
        request.bindingName !== SERVICE_BINDINGS.documents ||
        request.entrypoint !== DOCUMENTS_SERVICE_ENTRYPOINT ||
        request.bindingProvenance !== input.bindingProvenance ||
        request.serviceBuildId !== input.serviceBuildId
      ) {
        throw new DocumentsServiceLifecycleError(
          "installation_mismatch",
          "Documents lifecycle mutation does not match immutable deployment provenance",
        )
      }
      if (!input.lifecycleWriter) {
        throw new DocumentsServiceLifecycleError("runtime_unavailable", "Documents lifecycle writer is unavailable")
      }
      return input.lifecycleWriter.apply(request)
    },
    async probe(request) {
      requireProbeRequest(request, input)
      const lifecycle = await requireLifecycle(input)
      if (request.installationRevision !== lifecycle.revision) {
        throw new DocumentsServiceLifecycleError(
          "lifecycle_mismatch",
          "Documents probe revision does not match service lifecycle",
        )
      }
      if (lifecycle.state === "enabling") {
        throw new DocumentsServiceLifecycleError("service_disabled", "Documents enablement is not committed")
      }
      if (lifecycle.state === "enabled") await requireRuntime(input).probe()
      return {
        serviceId: "documents",
        protocolVersion: SERVICE_PROTOCOL_VERSION,
        schemaVersion: DOCUMENTS_SERVICE_SCHEMA_VERSION,
        state: lifecycle.state,
        serviceBuildId: lifecycle.serviceBuildId,
      }
    },
    async enqueue(request) {
      const lifecycle = await requireLifecycle(input)
      if (lifecycle.state !== "enabled") {
        throw new DocumentsServiceLifecycleError("service_disabled", "Documents service is installed but disabled")
      }
      return requireRuntime(input).enqueue(request)
    },
  }
}
