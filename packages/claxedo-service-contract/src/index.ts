/**
 * The complete optional-service vocabulary. This is intentionally a closed
 * union: installing first-party Workers must not turn core into a remote-code
 * plugin host.
 */
export const FIRST_PARTY_SERVICE_IDS = ["workgraph", "documents"] as const

export type FirstPartyServiceId = (typeof FIRST_PARTY_SERVICE_IDS)[number]
export type InstalledServiceState = "installed_disabled" | "enabled"
export type ServiceHealth = "ready" | "unhealthy"

export const SERVICE_PROTOCOL_VERSION = "claxedo.service.v1" as const

export const SERVICE_BINDINGS = {
  workgraph: "WORKGRAPH_SERVICE",
  documents: "DOCUMENTS_SERVICE",
} as const satisfies Record<FirstPartyServiceId, string>

export type ServiceBindingName = (typeof SERVICE_BINDINGS)[FirstPartyServiceId]

export type ServiceTrustMetadata = Readonly<{
  environmentId: string
  deploymentId: string
  bindingProvenance: string
}>

export type ServiceHealthProbe = Readonly<{
  status: ServiceHealth
  checkedAt: string
  serviceBuildId: string
}>

export type ServiceInstallationOperationIdentity = Readonly<{
  environmentId: string
  deploymentId: string
  operationId: string
  occurredAt: string
}>

export type ServiceLocalLifecycleState = InstalledServiceState | "enabling"

export type ServiceLifecycleMutationAction =
  "initialize_disabled" | "record_probe" | "prepare_enable" | "commit_enable" | "disable" | "uninstall"

/**
 * Deployment-only command sent over the private service-management binding.
 * Every provenance field is repeated deliberately: the service validates the
 * command against its immutable deployment configuration before touching its
 * local ledger.
 */
export type ServiceLifecycleMutationRequest = Readonly<{
  action: ServiceLifecycleMutationAction
  identity: ServiceInstallationOperationIdentity
  serviceId: FirstPartyServiceId
  protocolVersion: typeof SERVICE_PROTOCOL_VERSION
  schemaVersion: number
  bindingName: ServiceBindingName
  entrypoint: string
  bindingProvenance: string
  serviceBuildId: string
  expectedRevision: number
}>

export type ServiceLifecycleMutationResponse = Readonly<{
  serviceId: FirstPartyServiceId
  action: ServiceLifecycleMutationAction
  operationId: string
  state: ServiceLocalLifecycleState | "uninstalled"
  revision: number | null
  serviceBuildId: string
}>

export type ServiceInstallationOperationIntent =
  | Readonly<{
      action: "register_disabled"
      identity: ServiceInstallationOperationIdentity
      descriptor: FirstPartyServiceDescriptor
    }>
  | Readonly<{
      action: "record_probe"
      identity: ServiceInstallationOperationIdentity
      serviceId: FirstPartyServiceId
      expectedRevision: number
      probe: ServiceHealthProbe
    }>
  | Readonly<{
      action: "enable" | "disable"
      identity: ServiceInstallationOperationIdentity
      serviceId: FirstPartyServiceId
      expectedRevision: number
    }>
  | Readonly<{
      action: "uninstall"
      identity: ServiceInstallationOperationIdentity
      serviceId: FirstPartyServiceId
      expectedRevision: number
    }>

type ServiceDescriptorBase = Readonly<{
  protocolVersion: typeof SERVICE_PROTOCOL_VERSION
  schemaVersion: number
  state: InstalledServiceState
  entrypoint: string
  trust: ServiceTrustMetadata
  lastHealthProbe?: ServiceHealthProbe
}>

export type WorkGraphServiceDescriptor = ServiceDescriptorBase &
  Readonly<{
    serviceId: "workgraph"
    bindingName: typeof SERVICE_BINDINGS.workgraph
  }>

export type DocumentsServiceDescriptor = ServiceDescriptorBase &
  Readonly<{
    serviceId: "documents"
    bindingName: typeof SERVICE_BINDINGS.documents
  }>

export type FirstPartyServiceDescriptor = WorkGraphServiceDescriptor | DocumentsServiceDescriptor
export type FirstPartyServiceCatalog = readonly FirstPartyServiceDescriptor[]

/** Safe, data-only service availability advertised to signed application UIs. */
export type BrowserServiceDescriptor = Readonly<{
  serviceId: FirstPartyServiceId
  protocolVersion: typeof SERVICE_PROTOCOL_VERSION
  schemaVersion: number
  state: InstalledServiceState
}>

export type BrowserServiceCatalog = readonly BrowserServiceDescriptor[]

/** Absence is the canonical uninstalled state. */
export const EMPTY_SERVICE_CATALOG: FirstPartyServiceCatalog = Object.freeze([])
export const EMPTY_SERVICE_MANIFEST_ID = "empty-services-v1" as const

export class ServiceContractError extends Error {
  constructor(
    public readonly code:
      | "unknown_service"
      | "invalid_binding"
      | "invalid_protocol"
      | "invalid_schema"
      | "invalid_descriptor"
      | "duplicate_service",
    message: string,
  ) {
    super(message)
    this.name = "ServiceContractError"
  }
}

export function isFirstPartyServiceId(value: unknown): value is FirstPartyServiceId {
  return typeof value === "string" && (FIRST_PARTY_SERVICE_IDS as readonly string[]).includes(value)
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() !== value || !value) {
    throw new ServiceContractError("invalid_descriptor", `${field} must be a non-empty, trimmed string`)
  }
  return value
}

export function requireServiceDescriptor(value: unknown): FirstPartyServiceDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceContractError("invalid_descriptor", "service descriptor must be an object")
  }
  const descriptor = value as Record<string, unknown>
  if (!isFirstPartyServiceId(descriptor.serviceId)) {
    throw new ServiceContractError("unknown_service", "serviceId must be workgraph or documents")
  }
  const serviceId = descriptor.serviceId
  if (descriptor.bindingName !== SERVICE_BINDINGS[serviceId]) {
    throw new ServiceContractError(
      "invalid_binding",
      `${serviceId} must use the fixed ${SERVICE_BINDINGS[serviceId]} binding`,
    )
  }
  if (descriptor.protocolVersion !== SERVICE_PROTOCOL_VERSION) {
    throw new ServiceContractError("invalid_protocol", `protocolVersion must be ${SERVICE_PROTOCOL_VERSION}`)
  }
  if (!Number.isSafeInteger(descriptor.schemaVersion) || Number(descriptor.schemaVersion) <= 0) {
    throw new ServiceContractError("invalid_schema", "schemaVersion must be a positive safe integer")
  }
  if (descriptor.state !== "installed_disabled" && descriptor.state !== "enabled") {
    throw new ServiceContractError("invalid_descriptor", "state must be installed_disabled or enabled")
  }
  const trust = descriptor.trust
  if (!trust || typeof trust !== "object" || Array.isArray(trust)) {
    throw new ServiceContractError("invalid_descriptor", "trust metadata must be an object")
  }
  const trustRecord = trust as Record<string, unknown>
  const normalized = {
    serviceId,
    protocolVersion: SERVICE_PROTOCOL_VERSION,
    schemaVersion: Number(descriptor.schemaVersion),
    state: descriptor.state,
    bindingName: SERVICE_BINDINGS[serviceId],
    entrypoint: requiredText(descriptor.entrypoint, "entrypoint"),
    trust: {
      environmentId: requiredText(trustRecord.environmentId, "trust.environmentId"),
      deploymentId: requiredText(trustRecord.deploymentId, "trust.deploymentId"),
      bindingProvenance: requiredText(trustRecord.bindingProvenance, "trust.bindingProvenance"),
    },
    ...(descriptor.lastHealthProbe === undefined
      ? {}
      : { lastHealthProbe: requireServiceHealthProbe(descriptor.lastHealthProbe) }),
  }
  return normalized as FirstPartyServiceDescriptor
}

export function requireServiceHealthProbe(value: unknown): ServiceHealthProbe {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceContractError("invalid_descriptor", "lastHealthProbe must be an object")
  }
  const probe = value as Record<string, unknown>
  if (probe.status !== "ready" && probe.status !== "unhealthy") {
    throw new ServiceContractError("invalid_descriptor", "lastHealthProbe.status must be ready or unhealthy")
  }
  return {
    status: probe.status,
    checkedAt: requiredText(probe.checkedAt, "lastHealthProbe.checkedAt"),
    serviceBuildId: requiredText(probe.serviceBuildId, "lastHealthProbe.serviceBuildId"),
  }
}

function requireOperationIdentity(value: ServiceInstallationOperationIdentity) {
  return {
    environmentId: requiredText(value.environmentId, "identity.environmentId"),
    deploymentId: requiredText(value.deploymentId, "identity.deploymentId"),
    operationId: requiredText(value.operationId, "identity.operationId"),
    occurredAt: requiredText(value.occurredAt, "identity.occurredAt"),
  }
}

function requireExpectedRevision(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ServiceContractError("invalid_descriptor", "expectedRevision must be a positive safe integer")
  }
  return value
}

function requireLifecycleExpectedRevision(value: number, action: ServiceLifecycleMutationAction) {
  const minimum = action === "initialize_disabled" ? 0 : 1
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new ServiceContractError(
      "invalid_descriptor",
      `expectedRevision must be a safe integer greater than or equal to ${minimum}`,
    )
  }
  if (action !== "initialize_disabled" && value === 0) {
    throw new ServiceContractError("invalid_descriptor", "only initialization may target revision zero")
  }
  return value
}

export function requireServiceLifecycleMutationRequest(value: unknown): ServiceLifecycleMutationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceContractError("invalid_descriptor", "service lifecycle mutation must be an object")
  }
  const request = value as Record<string, unknown>
  const actions = new Set<ServiceLifecycleMutationAction>([
    "initialize_disabled",
    "record_probe",
    "prepare_enable",
    "commit_enable",
    "disable",
    "uninstall",
  ])
  if (!actions.has(request.action as ServiceLifecycleMutationAction)) {
    throw new ServiceContractError("invalid_descriptor", "unknown service lifecycle mutation action")
  }
  if (!isFirstPartyServiceId(request.serviceId)) {
    throw new ServiceContractError("unknown_service", "serviceId must be workgraph or documents")
  }
  const action = request.action as ServiceLifecycleMutationAction
  const serviceId = request.serviceId
  if (request.protocolVersion !== SERVICE_PROTOCOL_VERSION) {
    throw new ServiceContractError("invalid_protocol", `protocolVersion must be ${SERVICE_PROTOCOL_VERSION}`)
  }
  if (!Number.isSafeInteger(request.schemaVersion) || Number(request.schemaVersion) <= 0) {
    throw new ServiceContractError("invalid_schema", "schemaVersion must be a positive safe integer")
  }
  if (request.bindingName !== SERVICE_BINDINGS[serviceId]) {
    throw new ServiceContractError("invalid_binding", `${serviceId} must use its fixed service binding`)
  }
  const identityValue = request.identity
  if (!identityValue || typeof identityValue !== "object" || Array.isArray(identityValue)) {
    throw new ServiceContractError("invalid_descriptor", "identity must be an object")
  }
  const identity = requireOperationIdentity(identityValue as ServiceInstallationOperationIdentity)
  return Object.freeze({
    action,
    identity,
    serviceId,
    protocolVersion: SERVICE_PROTOCOL_VERSION,
    schemaVersion: Number(request.schemaVersion),
    bindingName: SERVICE_BINDINGS[serviceId],
    entrypoint: requiredText(request.entrypoint, "entrypoint"),
    bindingProvenance: requiredText(request.bindingProvenance, "bindingProvenance"),
    serviceBuildId: requiredText(request.serviceBuildId, "serviceBuildId"),
    expectedRevision: requireLifecycleExpectedRevision(Number(request.expectedRevision), action),
  })
}

export function serializeServiceLifecycleMutationRequest(value: ServiceLifecycleMutationRequest): string {
  return JSON.stringify({ version: 1, ...requireServiceLifecycleMutationRequest(value) })
}

/** Derives collision-free child identities while preserving the operator's root operation. */
export function serviceLifecycleStepIdentity(
  identity: ServiceInstallationOperationIdentity,
  step: string,
): ServiceInstallationOperationIdentity {
  const normalized = requireOperationIdentity(identity)
  const normalizedStep = requiredText(step, "step")
  return Object.freeze({
    ...normalized,
    operationId: `${normalized.operationId.length}:${normalized.operationId}:${normalizedStep}`,
  })
}

/**
 * Canonical, lossless operation identity persisted by every installation
 * adapter. This deliberately stores the normalized intent instead of a short
 * hash: an operation-id collision must be impossible to hide behind a digest
 * collision, and the audit record remains independently explainable.
 */
export function serializeServiceInstallationOperationIntent(value: ServiceInstallationOperationIntent): string {
  const identity = requireOperationIdentity(value.identity)
  if (value.action === "register_disabled") {
    return JSON.stringify({
      version: 1,
      action: value.action,
      identity,
      descriptor: requireServiceDescriptor(value.descriptor),
    })
  }
  if (!isFirstPartyServiceId(value.serviceId)) {
    throw new ServiceContractError("unknown_service", "serviceId must be workgraph or documents")
  }
  const common = {
    version: 1,
    action: value.action,
    identity,
    serviceId: value.serviceId,
    expectedRevision: requireExpectedRevision(value.expectedRevision),
  }
  if (value.action === "record_probe") {
    return JSON.stringify({ ...common, probe: requireServiceHealthProbe(value.probe) })
  }
  return JSON.stringify(common)
}

export function requireServiceCatalog(value: unknown): FirstPartyServiceCatalog {
  if (!Array.isArray(value)) throw new ServiceContractError("invalid_descriptor", "service catalog must be an array")
  const catalog = value
    .map(requireServiceDescriptor)
    .toSorted((left, right) => left.serviceId.localeCompare(right.serviceId))
  if (new Set(catalog.map((item) => item.serviceId)).size !== catalog.length) {
    throw new ServiceContractError("duplicate_service", "service catalog contains a duplicate service")
  }
  return Object.freeze(catalog)
}

const BROWSER_SERVICE_DESCRIPTOR_KEYS = new Set(["serviceId", "protocolVersion", "schemaVersion", "state"])

export function requireBrowserServiceDescriptor(value: unknown): BrowserServiceDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceContractError("invalid_descriptor", "browser service descriptor must be an object")
  }
  const descriptor = value as Record<string, unknown>
  if (Object.keys(descriptor).some((key) => !BROWSER_SERVICE_DESCRIPTOR_KEYS.has(key))) {
    throw new ServiceContractError("invalid_descriptor", "browser service descriptor contains operator-only fields")
  }
  if (!isFirstPartyServiceId(descriptor.serviceId)) {
    throw new ServiceContractError("unknown_service", "serviceId must be workgraph or documents")
  }
  if (descriptor.protocolVersion !== SERVICE_PROTOCOL_VERSION) {
    throw new ServiceContractError("invalid_protocol", `protocolVersion must be ${SERVICE_PROTOCOL_VERSION}`)
  }
  if (!Number.isSafeInteger(descriptor.schemaVersion) || Number(descriptor.schemaVersion) <= 0) {
    throw new ServiceContractError("invalid_schema", "schemaVersion must be a positive safe integer")
  }
  if (descriptor.state !== "installed_disabled" && descriptor.state !== "enabled") {
    throw new ServiceContractError("invalid_descriptor", "state must be installed_disabled or enabled")
  }
  return Object.freeze({
    serviceId: descriptor.serviceId,
    protocolVersion: SERVICE_PROTOCOL_VERSION,
    schemaVersion: Number(descriptor.schemaVersion),
    state: descriptor.state,
  })
}

export function requireBrowserServiceCatalog(value: unknown): BrowserServiceCatalog {
  if (!Array.isArray(value))
    throw new ServiceContractError("invalid_descriptor", "browser service catalog must be an array")
  const catalog = value
    .map(requireBrowserServiceDescriptor)
    .toSorted((left, right) => left.serviceId.localeCompare(right.serviceId))
  if (new Set(catalog.map((item) => item.serviceId)).size !== catalog.length) {
    throw new ServiceContractError("duplicate_service", "browser service catalog contains a duplicate service")
  }
  return Object.freeze(catalog)
}

export function projectServiceCatalogForBrowser(value: unknown): BrowserServiceCatalog {
  return Object.freeze(
    requireServiceCatalog(value).map((descriptor) =>
      Object.freeze({
        serviceId: descriptor.serviceId,
        protocolVersion: descriptor.protocolVersion,
        schemaVersion: descriptor.schemaVersion,
        state: descriptor.state,
      }),
    ),
  )
}

export type ServiceProbeRequest = Readonly<{
  environmentId: string
  deploymentId: string
  installationRevision: number
  protocolVersion: typeof SERVICE_PROTOCOL_VERSION
}>

export type ServiceProbeResponse = Readonly<{
  serviceId: FirstPartyServiceId
  protocolVersion: typeof SERVICE_PROTOCOL_VERSION
  schemaVersion: number
  state: InstalledServiceState
  serviceBuildId: string
}>

export interface ServiceLifecycleRpc {
  probe(request: ServiceProbeRequest): Promise<ServiceProbeResponse>
  applyLifecycle(request: ServiceLifecycleMutationRequest): Promise<ServiceLifecycleMutationResponse>
}
