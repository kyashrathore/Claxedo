import type { D1Database } from "@cloudflare/workers-types"

import {
  ServiceDeploymentStepError,
  requireDeploymentStepIdentity,
  type ServiceDeploymentStepReceipt,
  type ServiceDeploymentStepStore,
} from "../deployment-step-store"
import type { ServiceDeploymentStepIdentity } from "../lifecycle-coordinator"

type Row = Readonly<{
  environmentId: string
  deploymentId: string
  stepOperationId: string
  workflowOperationId: string
  serviceId: ServiceDeploymentStepIdentity["serviceId"]
  serviceBuildId: string
  bindingProvenance: string
  step: ServiceDeploymentStepIdentity["step"]
  operationIntent: string
  state: "started" | "completed"
  resultJson: string | null
  startedAt: string
  completedAt: string | null
}>

const COLUMNS = `environment_id as environmentId, deployment_id as deploymentId,
  step_operation_id as stepOperationId, workflow_operation_id as workflowOperationId,
  service_id as serviceId, service_build_id as serviceBuildId,
  binding_provenance as bindingProvenance, step, operation_intent as operationIntent, state,
  result_json as resultJson, started_at as startedAt, completed_at as completedAt`

function requiredIntent(value: string) {
  if (!value || value.trim() !== value) {
    throw new ServiceDeploymentStepError("invalid_identity", "operationIntent must be canonical")
  }
  return value
}

function receipt(row: Row): ServiceDeploymentStepReceipt {
  let result: Readonly<Record<string, unknown>> | null = null
  if (row.state === "completed") {
    try {
      const parsed = JSON.parse(row.resultJson ?? "")
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object")
      result = Object.freeze(parsed as Record<string, unknown>)
    } catch {
      throw new ServiceDeploymentStepError("completion_conflict", "deployment step result is malformed")
    }
  }
  return Object.freeze({
    identity: Object.freeze({
      environmentId: row.environmentId,
      deploymentId: row.deploymentId,
      workflowOperationId: row.workflowOperationId,
      stepOperationId: row.stepOperationId,
      occurredAt: row.startedAt,
      serviceId: row.serviceId,
      serviceBuildId: row.serviceBuildId,
      bindingProvenance: row.bindingProvenance,
      step: row.step,
    }),
    operationIntent: row.operationIntent,
    state: row.state,
    result,
  })
}

/** D1-backed exact-once intent ledger. Started receipts are deliberately rerunnable. */
export class D1ServiceDeploymentStepStore implements ServiceDeploymentStepStore {
  constructor(private readonly database: D1Database) {}

  async begin(identity: ServiceDeploymentStepIdentity, rawIntent: string) {
    const normalized = requireDeploymentStepIdentity(identity)
    const operationIntent = requiredIntent(rawIntent)
    await this.database
      .prepare(
        `insert or ignore into service_deployment_steps (
           environment_id, deployment_id, step_operation_id, workflow_operation_id,
           service_id, service_build_id, binding_provenance, step, operation_intent, state, started_at
         ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'started', ?)`,
      )
      .bind(
        normalized.environmentId,
        normalized.deploymentId,
        normalized.stepOperationId,
        normalized.workflowOperationId,
        normalized.serviceId,
        normalized.serviceBuildId,
        normalized.bindingProvenance,
        normalized.step,
        operationIntent,
        normalized.occurredAt,
      )
      .run()
    return this.requireExact(normalized, operationIntent)
  }

  async complete(
    identity: ServiceDeploymentStepIdentity,
    rawIntent: string,
    result: Readonly<Record<string, unknown>>,
  ) {
    const normalized = requireDeploymentStepIdentity(identity)
    const operationIntent = requiredIntent(rawIntent)
    const resultJson = JSON.stringify(result)
    await this.database
      .prepare(
        `update service_deployment_steps
         set state = 'completed', result_json = ?, completed_at = ?
         where environment_id = ? and deployment_id = ? and step_operation_id = ?
           and operation_intent = ? and state = 'started'`,
      )
      .bind(
        resultJson,
        normalized.occurredAt,
        normalized.environmentId,
        normalized.deploymentId,
        normalized.stepOperationId,
        operationIntent,
      )
      .run()
    const current = await this.requireExact(normalized, operationIntent)
    if (current.state !== "completed" || JSON.stringify(current.result) !== resultJson) {
      throw new ServiceDeploymentStepError("completion_conflict", "deployment step completed with another result")
    }
    return current
  }

  async get(scope: { environmentId: string; deploymentId: string }, stepOperationId: string) {
    const row = await this.database
      .prepare(`select ${COLUMNS} from service_deployment_steps where environment_id = ? and deployment_id = ? and step_operation_id = ?`)
      .bind(scope.environmentId, scope.deploymentId, stepOperationId)
      .first<Row>()
    return row ? receipt(row) : null
  }

  private async requireExact(identity: ServiceDeploymentStepIdentity, operationIntent: string) {
    const row = await this.get(identity, identity.stepOperationId)
    if (
      !row ||
      row.operationIntent !== operationIntent ||
      row.identity.workflowOperationId !== identity.workflowOperationId ||
      row.identity.serviceId !== identity.serviceId ||
      row.identity.serviceBuildId !== identity.serviceBuildId ||
      row.identity.bindingProvenance !== identity.bindingProvenance ||
      row.identity.step !== identity.step
    ) {
      throw new ServiceDeploymentStepError("operation_conflict", "deployment step id belongs to another intent")
    }
    return row
  }
}
