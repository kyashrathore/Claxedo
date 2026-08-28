import {
  serializeServiceLifecycleMutationRequest,
  type ServiceLifecycleMutationRequest,
  type ServiceLifecycleMutationResponse,
  type ServiceLocalLifecycleState,
} from "@claxedo/service-contract"

import type {
  WorkGraphServiceLifecycle,
  WorkGraphServiceLifecycleReader,
  WorkGraphServiceLifecycleWriter,
} from "./service"

type D1Result = Readonly<{ success: boolean; meta: Readonly<{ changes: number }> }>

export interface WorkGraphLifecycleStatement {
  bind(...values: unknown[]): WorkGraphLifecycleStatement
  first(): Promise<unknown>
  run(): Promise<D1Result>
}

export interface WorkGraphLifecycleD1 {
  prepare(sql: string): WorkGraphLifecycleStatement
  batch(statements: WorkGraphLifecycleStatement[]): Promise<unknown[]>
}

type WorkGraphLifecycleIdentity = Pick<WorkGraphServiceLifecycle, "environmentId" | "deploymentId" | "serviceBuildId">

type LifecycleRow = Readonly<{
  initializerOperationId: string
  state: ServiceLocalLifecycleState
  revision: number
}>
type AuditRow = Readonly<{
  operationIntent: string
  action: ServiceLifecycleMutationRequest["action"]
  toState: ServiceLocalLifecycleState | null
  toRevision: number | null
}>

export class D1WorkGraphServiceLifecycleStore
  implements WorkGraphServiceLifecycleReader, WorkGraphServiceLifecycleWriter
{
  constructor(
    private readonly database: WorkGraphLifecycleD1,
    private readonly identity: WorkGraphLifecycleIdentity,
  ) {}

  async read(): Promise<WorkGraphServiceLifecycle | undefined> {
    const value = await this.row()
    return value ? { ...this.identity, state: value.state, revision: value.revision } : undefined
  }

  async apply(request: ServiceLifecycleMutationRequest): Promise<ServiceLifecycleMutationResponse> {
    const operationIntent = serializeServiceLifecycleMutationRequest(request)
    if (request.action === "initialize_disabled") {
      await this.database.batch([
        this.database
          .prepare(
            `
            insert or ignore into workgraph_service_lifecycle (
              singleton, initializer_operation_id, state, revision, updated_at
            )
            select 1, ?, 'installed_disabled', 1, ?
            where not exists (select 1 from workgraph_service_lifecycle_audit where operation_id = ?)
          `,
          )
          .bind(request.identity.operationId, request.identity.occurredAt, request.identity.operationId),
        this.database
          .prepare(
            `
            insert or ignore into workgraph_service_lifecycle_audit (
              operation_id, operation_intent, action, from_state, to_state, from_revision, to_revision, occurred_at
            )
            select ?, ?, 'initialize_disabled', null, state, null, revision, ?
            from workgraph_service_lifecycle
            where singleton = 1 and revision = 1 and state = 'installed_disabled'
              and initializer_operation_id = ?
          `,
          )
          .bind(
            request.identity.operationId,
            operationIntent,
            request.identity.occurredAt,
            request.identity.operationId,
          ),
      ])
      return this.requireApplied(request, operationIntent)
    }

    if (request.action === "commit_enable") {
      await this.database.batch([
        this.auditInsert(
          request,
          operationIntent,
          "enabling",
          "enabled",
          request.expectedRevision,
          request.expectedRevision,
        ),
        this.database
          .prepare(
            `
            update workgraph_service_lifecycle set state = 'enabled', updated_at = ?
            where singleton = 1 and state = 'enabling' and revision = ?
              and exists (
                select 1 from workgraph_service_lifecycle_audit
                where operation_id = ? and operation_intent = ? and action = 'commit_enable'
                  and from_revision = ? and to_revision = ?
              )
          `,
          )
          .bind(
            request.identity.occurredAt,
            request.expectedRevision,
            request.identity.operationId,
            operationIntent,
            request.expectedRevision,
            request.expectedRevision,
          ),
      ])
      return this.requireApplied(request, operationIntent)
    }

    if (request.action === "uninstall") {
      await this.database.batch([
        this.auditInsert(request, operationIntent, "installed_disabled", null, request.expectedRevision, null),
        this.database
          .prepare(
            `
            delete from workgraph_service_lifecycle
            where singleton = 1 and state = 'installed_disabled' and revision = ?
              and exists (
                select 1 from workgraph_service_lifecycle_audit
                where operation_id = ? and operation_intent = ? and action = 'uninstall'
                  and from_revision = ? and to_revision is null
              )
          `,
          )
          .bind(request.expectedRevision, request.identity.operationId, operationIntent, request.expectedRevision),
      ])
      return this.requireApplied(request, operationIntent)
    }

    const transition = {
      record_probe: { from: ["installed_disabled", "enabled"] as const, to: undefined },
      prepare_enable: { from: ["installed_disabled"] as const, to: "enabling" as const },
      disable: { from: ["enabled"] as const, to: "installed_disabled" as const },
    }[request.action]
    const toRevision = request.expectedRevision + 1
    const allowedStates = transition.from.map(() => "?").join(", ")
    await this.database.batch([
      this.database
        .prepare(
          `
          insert or ignore into workgraph_service_lifecycle_audit (
            operation_id, operation_intent, action, from_state, to_state, from_revision, to_revision, occurred_at
          )
          select ?, ?, ?, state, ${transition.to ? "?" : "state"}, revision, revision + 1, ?
          from workgraph_service_lifecycle
          where singleton = 1 and revision = ? and state in (${allowedStates})
            and not exists (select 1 from workgraph_service_lifecycle_audit where operation_id = ?)
        `,
        )
        .bind(
          request.identity.operationId,
          operationIntent,
          request.action,
          ...(transition.to ? [transition.to] : []),
          request.identity.occurredAt,
          request.expectedRevision,
          ...transition.from,
          request.identity.operationId,
        ),
      this.database
        .prepare(
          `
          update workgraph_service_lifecycle
          set state = ${transition.to ? `'${transition.to}'` : "state"}, revision = revision + 1, updated_at = ?
          where singleton = 1 and revision = ? and state in (${allowedStates})
            and exists (
              select 1 from workgraph_service_lifecycle_audit
              where operation_id = ? and operation_intent = ? and action = ?
                and from_revision = ? and to_revision = ?
            )
        `,
        )
        .bind(
          request.identity.occurredAt,
          request.expectedRevision,
          ...transition.from,
          request.identity.operationId,
          operationIntent,
          request.action,
          request.expectedRevision,
          toRevision,
        ),
    ])
    return this.requireApplied(request, operationIntent)
  }

  private async row(): Promise<LifecycleRow | null> {
    const value = await this.database
      .prepare(
        `select initializer_operation_id as initializerOperationId, state, revision
         from workgraph_service_lifecycle where singleton = 1`,
      )
      .first()
    const row = value as LifecycleRow | null
    if (!row) return null
    if (
      typeof row.initializerOperationId !== "string" ||
      !row.initializerOperationId ||
      (row.state !== "installed_disabled" && row.state !== "enabling" && row.state !== "enabled") ||
      !Number.isSafeInteger(row.revision) ||
      row.revision <= 0
    )
      throw new Error("invalid lifecycle row")
    return row
  }

  private audit(operationId: string): Promise<AuditRow | null> {
    return this.database
      .prepare(
        `
        select operation_intent as operationIntent, action, to_state as toState, to_revision as toRevision
        from workgraph_service_lifecycle_audit where operation_id = ?
      `,
      )
      .bind(operationId)
      .first() as Promise<AuditRow | null>
  }

  private auditInsert(
    request: ServiceLifecycleMutationRequest,
    operationIntent: string,
    fromState: ServiceLocalLifecycleState,
    toState: ServiceLocalLifecycleState | null,
    fromRevision: number,
    toRevision: number | null,
  ) {
    return this.database
      .prepare(
        `
        insert or ignore into workgraph_service_lifecycle_audit (
          operation_id, operation_intent, action, from_state, to_state, from_revision, to_revision, occurred_at
        )
        select ?, ?, ?, ?, ?, ?, ?, ?
        where exists (
          select 1 from workgraph_service_lifecycle where singleton = 1 and state = ? and revision = ?
        )
      `,
      )
      .bind(
        request.identity.operationId,
        operationIntent,
        request.action,
        fromState,
        toState,
        fromRevision,
        toRevision,
        request.identity.occurredAt,
        fromState,
        fromRevision,
      )
  }

  private async requireApplied(
    request: ServiceLifecycleMutationRequest,
    operationIntent: string,
  ): Promise<ServiceLifecycleMutationResponse> {
    const [row, audit] = await Promise.all([this.row(), this.audit(request.identity.operationId)])
    if (!audit || audit.operationIntent !== operationIntent || audit.action !== request.action) {
      throw new Error(audit ? "lifecycle operation id was reused for another intent" : "lifecycle precondition failed")
    }
    if (request.action === "uninstall") {
      if (row || audit.toRevision !== null || audit.toState !== null)
        throw new Error("lifecycle uninstall did not commit")
      return this.response(request, "uninstalled", null)
    }
    if (!row || row.revision !== audit.toRevision || row.state !== audit.toState) {
      throw new Error("lifecycle mutation did not commit")
    }
    return this.response(request, row.state, row.revision)
  }

  private response(
    request: ServiceLifecycleMutationRequest,
    state: ServiceLocalLifecycleState | "uninstalled",
    revision: number | null,
  ): ServiceLifecycleMutationResponse {
    return {
      serviceId: "workgraph",
      action: request.action,
      operationId: request.identity.operationId,
      state,
      revision,
      serviceBuildId: this.identity.serviceBuildId,
    }
  }
}
