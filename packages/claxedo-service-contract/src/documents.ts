import type { SERVICE_PROTOCOL_VERSION, ServiceLifecycleRpc } from "./index"

/**
 * Job requests repeat their target installation identity for the same reason
 * ServiceLifecycleMutationRequest repeats provenance: the service validates the
 * request against its immutable deployment configuration before a grant or
 * payload field is trusted. installationRevision additionally binds the job to
 * one lifecycle generation, so work minted before a disable/uninstall cannot be
 * replayed into the next generation.
 */
export type DocumentsJobRequest = Readonly<{
  environmentId: string
  deploymentId: string
  installationRevision: number
  protocolVersion: typeof SERVICE_PROTOCOL_VERSION
  operationId: string
  operationGrant: string
  organizationId: string
  actorId: string
  job: "persist_document_revision"
  payload: Readonly<Record<string, unknown>>
}>

export type DocumentsJobReceipt = Readonly<{
  operationId: string
  accepted: boolean
  jobId: string
}>

export interface DocumentsServiceRpc {
  enqueue(request: DocumentsJobRequest): Promise<DocumentsJobReceipt>
}

export interface DocumentsServiceManagementRpc extends ServiceLifecycleRpc {}
