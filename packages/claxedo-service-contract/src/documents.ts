import type { ServiceLifecycleRpc } from "./index"

export const DOCUMENTS_SERVICE_BUDGET = Object.freeze({
  maxPayloadBytes: 512 * 1024,
  enqueueTimeoutMs: 10_000,
  maxConcurrentJobsPerInstallation: 16,
})

export type DocumentsJobRequest = Readonly<{
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
