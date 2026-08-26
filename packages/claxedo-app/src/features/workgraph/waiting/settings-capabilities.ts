/**
 * Pure projections of the execution capability catalog for the settings forms.
 *
 * Every choice a settings field can offer comes from `ExecutionCapabilities`, the
 * enumerable catalog the backend advertises. These helpers narrow that catalog to
 * the choices valid for the current selection: agents, models, and tools scoped to
 * the chosen harness, efforts scoped to the chosen model, plus the
 * repository inputs and connections. They never inject defaults or fabricate
 * options; an empty result means the catalog advertises nothing for that field.
 */
import type { ExecutionCapabilities, ExecutionEnvironmentCapability } from "@claxedo/workgraph/contracts"

/** Harness ids the catalog advertises. */
export function harnessChoices(capabilities: ExecutionCapabilities) {
  return capabilities.harnesses.map((harness) => harness.id)
}

/** Agents the catalog advertises for a harness. */
export function agentChoices(capabilities: ExecutionCapabilities, harnessId: string) {
  return capabilities.agents.filter((agent) => agent.harnessId === harnessId)
}

/** Models the catalog advertises for a harness. */
export function modelChoices(capabilities: ExecutionCapabilities, harnessId: string) {
  return capabilities.models.filter((model) => model.harnessId === harnessId)
}

/** Provider ids the catalog advertises for a harness, in catalog order. */
export function providerChoices(capabilities: ExecutionCapabilities, harnessId: string) {
  return [...new Set(modelChoices(capabilities, harnessId).map((model) => model.providerId))]
}

/** Models the catalog advertises for one provider of a harness. */
export function providerModelChoices(capabilities: ExecutionCapabilities, harnessId: string, providerId: string) {
  return modelChoices(capabilities, harnessId).filter((model) => model.providerId === providerId)
}

/** Efforts the catalog advertises for one model of a harness. */
export function effortChoices(
  capabilities: ExecutionCapabilities,
  harnessId: string,
  providerId: string,
  modelId: string,
) {
  return capabilities.models
    .filter((model) => model.harnessId === harnessId && model.providerId === providerId && model.modelId === modelId)
    .flatMap((model) => model.efforts)
}

/** Tools the catalog advertises for a harness. */
export function toolChoices(capabilities: ExecutionCapabilities, harnessId: string) {
  return capabilities.tools.filter((tool) => tool.harnessId === harnessId)
}

/** Environment kinds the catalog advertises. */
export function environmentChoices(capabilities: ExecutionCapabilities) {
  return capabilities.environments.map((environment) => environment.kind)
}

/**
 * The repository input policy advertised for one environment
 * (`repositoryRequired`, `remoteUrlInput`, `baseRevisionInput`). `undefined` when
 * the catalog does not advertise that environment.
 */
export function environmentPolicy(capabilities: ExecutionCapabilities, kind: ExecutionEnvironmentCapability["kind"]) {
  return capabilities.environments.find((environment) => environment.kind === kind)
}

/** Base revisions the catalog advertises for the repository. */
export function baseRevisionChoices(capabilities: ExecutionCapabilities) {
  return capabilities.repository.baseRevisions
}

/** Connections the catalog advertises. */
export function connectionChoices(capabilities: ExecutionCapabilities) {
  return capabilities.connections
}
