import { requireServiceDescriptor, serializeServiceInstallationOperationIntent } from "@claxedo/service-contract"
import { v } from "convex/values"
import { serviceMutation, serviceQuery } from "./model"

const serviceId = v.union(v.literal("workgraph"), v.literal("documents"))
const lifecycleState = v.union(v.literal("installed_disabled"), v.literal("enabled"))
const descriptor = v.object({
  serviceId,
  protocolVersion: v.literal("claxedo.service.v1"),
  schemaVersion: v.number(),
  state: lifecycleState,
  bindingName: v.union(v.literal("WORKGRAPH_SERVICE"), v.literal("DOCUMENTS_SERVICE")),
  entrypoint: v.string(),
  trust: v.object({
    environmentId: v.string(),
    deploymentId: v.string(),
    bindingProvenance: v.string(),
  }),
  lastHealthProbe: v.optional(v.object({
    status: v.union(v.literal("ready"), v.literal("unhealthy")),
    checkedAt: v.string(),
    serviceBuildId: v.string(),
  })),
})
const identity = v.object({
  environmentId: v.string(),
  deploymentId: v.string(),
  operationId: v.string(),
  occurredAt: v.string(),
})

type ServiceId = "workgraph" | "documents"
type Scope = { environmentId: string; deploymentId: string }

function requiredText(value: string, name: string) {
  if (!value || value.trim() !== value) throw new Error(`${name} must be a non-empty trimmed string`)
}

function requireIdentity(value: Scope & { operationId: string; occurredAt: string }) {
  requiredText(value.environmentId, "environmentId")
  requiredText(value.deploymentId, "deploymentId")
  requiredText(value.operationId, "operationId")
  requiredText(value.occurredAt, "occurredAt")
}

async function installation(ctx: any, scope: Scope, id: ServiceId) {
  return ctx.db.query("service_installations")
    .withIndex("by_deployment_service", (query: any) => query
      .eq("environment_id", scope.environmentId)
      .eq("deployment_id", scope.deploymentId)
      .eq("service_id", id))
    .unique()
}

async function operation(ctx: any, value: Scope & { operationId: string }) {
  return ctx.db.query("service_installation_audit")
    .withIndex("by_deployment_operation", (query: any) => query
      .eq("environment_id", value.environmentId)
      .eq("deployment_id", value.deploymentId)
      .eq("operation_id", value.operationId))
    .unique()
}

function project(row: any) {
  if (!row) throw new Error("service installation row disappeared")
  return {
    descriptor: {
      serviceId: row.service_id,
      protocolVersion: row.protocol_version,
      schemaVersion: row.schema_version,
      state: row.lifecycle_state,
      bindingName: row.binding_name,
      entrypoint: row.entrypoint,
      trust: {
        environmentId: row.environment_id,
        deploymentId: row.deployment_id,
        bindingProvenance: row.binding_provenance,
      },
      ...(row.probe_status ? {
        lastHealthProbe: {
          status: row.probe_status,
          checkedAt: row.probe_checked_at,
          serviceBuildId: row.service_build_id,
        },
      } : {}),
    },
    revision: row.revision,
  }
}

export const list = serviceQuery({
  args: { environmentId: v.string(), deploymentId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("service_installations")
      .withIndex("by_deployment_state", (query: any) => query
        .eq("environment_id", args.environmentId)
        .eq("deployment_id", args.deploymentId))
      .take(3)
    if (rows.length > 2) throw new Error("fixed service installation inventory exceeded")
    return rows.map(project).sort((left, right) => left.descriptor.serviceId.localeCompare(right.descriptor.serviceId))
  },
})

export const get = serviceQuery({
  args: { environmentId: v.string(), deploymentId: v.string(), serviceId },
  handler: async (ctx, args) => {
    const row = await installation(ctx, args, args.serviceId)
    return row ? project(row) : null
  },
})

export const audit = serviceQuery({
  args: { environmentId: v.string(), deploymentId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("service_installation_audit")
      .withIndex("by_deployment_time", (query: any) => query
        .eq("environment_id", args.environmentId)
        .eq("deployment_id", args.deploymentId))
      .take(1001)
    if (rows.length > 1000) throw new Error("service installation audit exceeds the bounded read")
    return rows.map((row) => ({
      environmentId: row.environment_id,
      deploymentId: row.deployment_id,
      operationId: row.operation_id,
      serviceId: row.service_id,
      action: row.action,
      ...(row.from_revision === undefined ? {} : { fromRevision: row.from_revision }),
      ...(row.to_revision === undefined ? {} : { toRevision: row.to_revision }),
      occurredAt: row.occurred_at,
    }))
  },
})

export const registerDisabled = serviceMutation({
  args: { identity, descriptor },
  handler: async (ctx, args) => {
    requireIdentity(args.identity)
    const value = requireServiceDescriptor(args.descriptor)
    if (value.state !== "installed_disabled") throw new Error("service must first be installed_disabled")
    if (value.lastHealthProbe !== undefined) throw new Error("service must be probed after registration")
    if (value.trust.environmentId !== args.identity.environmentId || value.trust.deploymentId !== args.identity.deploymentId) {
      throw new Error("service trust metadata does not match deployment identity")
    }
    const operationIntent = serializeServiceInstallationOperationIntent({
      action: "register_disabled",
      identity: args.identity,
      descriptor: value,
    })
    const priorOperation = await operation(ctx, args.identity)
    const existing = await installation(ctx, args.identity, value.serviceId)
    if (priorOperation) {
      if (
        !existing ||
        priorOperation.service_id !== value.serviceId ||
        priorOperation.action !== "register_disabled" ||
        priorOperation.operation_intent !== operationIntent
      ) {
        throw new Error("operation id was already used for another installation mutation")
      }
      return project(existing)
    }
    if (existing) throw new Error("service is already installed")
    const id = await ctx.db.insert("service_installations", {
      environment_id: args.identity.environmentId,
      deployment_id: args.identity.deploymentId,
      service_id: value.serviceId,
      protocol_version: value.protocolVersion,
      schema_version: value.schemaVersion,
      lifecycle_state: value.state,
      binding_name: value.bindingName,
      entrypoint: value.entrypoint,
      binding_provenance: value.trust.bindingProvenance,
      revision: 1,
      last_operation_id: args.identity.operationId,
      updated_at: args.identity.occurredAt,
    })
    await ctx.db.insert("service_installation_audit", {
      environment_id: args.identity.environmentId,
      deployment_id: args.identity.deploymentId,
      operation_id: args.identity.operationId,
      operation_intent: operationIntent,
      service_id: value.serviceId,
      action: "register_disabled",
      to_revision: 1,
      occurred_at: args.identity.occurredAt,
    })
    return project(await ctx.db.get(id))
  },
})

export const recordProbe = serviceMutation({
  args: {
    identity,
    serviceId,
    expectedRevision: v.number(),
    probe: v.object({
      status: v.union(v.literal("ready"), v.literal("unhealthy")),
      checkedAt: v.string(),
      serviceBuildId: v.string(),
    }),
  },
  handler: async (ctx, args) => {
    const operationIntent = serializeServiceInstallationOperationIntent({
      action: "record_probe",
      identity: args.identity,
      serviceId: args.serviceId,
      expectedRevision: args.expectedRevision,
      probe: args.probe,
    })
    return mutate(ctx, args, "record_probe", operationIntent, {
      probe_status: args.probe.status,
      probe_checked_at: args.probe.checkedAt,
      service_build_id: args.probe.serviceBuildId,
    })
  },
})

export const transition = serviceMutation({
  args: { identity, serviceId, expectedRevision: v.number(), state: lifecycleState },
  handler: async (ctx, args) => {
    const expectedState = args.state === "enabled" ? "installed_disabled" : "enabled"
    const action = args.state === "enabled" ? "enable" : "disable"
    const operationIntent = serializeServiceInstallationOperationIntent({
      action,
      identity: args.identity,
      serviceId: args.serviceId,
      expectedRevision: args.expectedRevision,
    })
    return mutate(ctx, args, action, operationIntent, { lifecycle_state: args.state }, (existing) => {
      if (existing.lifecycle_state !== expectedState) throw new Error("service lifecycle transition is invalid")
      if (args.state === "enabled" && existing.probe_status !== "ready") throw new Error("ready probe required")
    })
  },
})

async function mutate(
  ctx: any,
  args: { identity: Scope & { operationId: string; occurredAt: string }; serviceId: ServiceId; expectedRevision: number },
  action: "record_probe" | "enable" | "disable",
  operationIntent: string,
  patch: Record<string, unknown>,
  validate?: (existing: any) => void,
) {
  requireIdentity(args.identity)
  const priorOperation = await operation(ctx, args.identity)
  const existing = await installation(ctx, args.identity, args.serviceId)
  if (priorOperation) {
    if (
      !existing ||
      existing.last_operation_id !== args.identity.operationId ||
      priorOperation.action !== action ||
      priorOperation.service_id !== args.serviceId ||
      priorOperation.operation_intent !== operationIntent
    ) {
      throw new Error("operation id was already used for another installation mutation")
    }
    return project(existing)
  }
  if (!existing) throw new Error("service is not installed")
  if (existing.revision !== args.expectedRevision) throw new Error("service installation revision conflict")
  validate?.(existing)
  const revision = existing.revision + 1
  await ctx.db.patch(existing._id, {
    ...patch,
    revision,
    last_operation_id: args.identity.operationId,
    updated_at: args.identity.occurredAt,
  })
  await ctx.db.insert("service_installation_audit", {
    environment_id: args.identity.environmentId,
    deployment_id: args.identity.deploymentId,
    operation_id: args.identity.operationId,
    operation_intent: operationIntent,
    service_id: args.serviceId,
    action,
    from_revision: existing.revision,
    to_revision: revision,
    occurred_at: args.identity.occurredAt,
  })
  return project({ ...existing, ...patch, revision, last_operation_id: args.identity.operationId })
}

export const uninstall = serviceMutation({
  args: { identity, serviceId, expectedRevision: v.number() },
  handler: async (ctx, args) => {
    requireIdentity(args.identity)
    const operationIntent = serializeServiceInstallationOperationIntent({
      action: "uninstall",
      identity: args.identity,
      serviceId: args.serviceId,
      expectedRevision: args.expectedRevision,
    })
    const priorOperation = await operation(ctx, args.identity)
    const existing = await installation(ctx, args.identity, args.serviceId)
    if (priorOperation) {
      if (
        priorOperation.service_id !== args.serviceId ||
        priorOperation.action !== "uninstall" ||
        priorOperation.operation_intent !== operationIntent
      ) {
        throw new Error("operation id was already used for another installation mutation")
      }
      if (existing) throw new Error("retried uninstall still has an installation row")
      return null
    }
    if (!existing) throw new Error("service is not installed")
    if (existing.lifecycle_state !== "installed_disabled") throw new Error("enabled service must be disabled before uninstall")
    if (existing.revision !== args.expectedRevision) throw new Error("service installation revision conflict")
    await ctx.db.insert("service_installation_audit", {
      environment_id: args.identity.environmentId,
      deployment_id: args.identity.deploymentId,
      operation_id: args.identity.operationId,
      operation_intent: operationIntent,
      service_id: args.serviceId,
      action: "uninstall",
      from_revision: existing.revision,
      occurred_at: args.identity.occurredAt,
    })
    await ctx.db.delete(existing._id)
    return null
  },
})
