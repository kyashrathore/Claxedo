import type { ServiceLifecycleRpc } from "./index"

export const WORKGRAPH_SERVICE_BUDGET = Object.freeze({
  maxPayloadBytes: 256 * 1024,
  operationTimeoutMs: 15_000,
  maxConcurrentOperationsPerInstallation: 32,
})

export type WorkGraphMutationRequest = Readonly<{
  operationId: string
  operationGrant: string
  organizationId: string
  actorId: string
  mutation: "record_work_item_transition"
  payload: Readonly<Record<string, unknown>>
}>

export type WorkGraphMutationResult = Readonly<{
  operationId: string
  committed: boolean
  revision: string
}>

export interface WorkGraphServiceRpc {
  mutate(request: WorkGraphMutationRequest): Promise<WorkGraphMutationResult>
}

export interface WorkGraphServiceManagementRpc extends ServiceLifecycleRpc {}
