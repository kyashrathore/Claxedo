import { isArtifactDigest } from "@claxedo/server-core/agent-plugins/activation/types"
import type { AgentPluginArtifactPin } from "@claxedo/server-core/agent-plugins/activation/store"

export const CLAXEDO_SCOPE_KEY = "claxedo"

export type PinRow = {
  plugin_instance_id: string
  artifact_digest: string
  source_id: string
  relative_path: string
  source_revision: string
}

export type HarnessRow = {
  plugin_instance_id: string
  harness_id: string
}

export type ChoiceRow = HarnessRow & {
  enabled: number
}

export type ScopedPinRow = PinRow & {
  scope_key: string
}

export const PIN_COLUMNS = "plugin_instance_id, artifact_digest, source_id, relative_path, source_revision"

export function userScopeKey(orgId: string, ownerUserId: string) {
  return `${orgId}:user:${ownerUserId}`
}

export function organizationScopeKey(orgId: string) {
  return `${orgId}:organization`
}

export function invalid(detail: string): never {
  throw new Error(`D1 returned an invalid Agent Plugins ${detail}`)
}

export function text(value: unknown, detail: string) {
  if (typeof value !== "string" || !value) invalid(detail)
  return value
}

export function revisionNumber(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid("revision")
  return value
}

export function enabled(value: unknown) {
  if (value !== 0 && value !== 1) invalid("activation choice")
  return value === 1
}

export function artifactPin(row: PinRow | null): AgentPluginArtifactPin | undefined {
  if (!row) return undefined
  if (!isArtifactDigest(row.artifact_digest)) invalid("artifact digest")
  return {
    digest: row.artifact_digest,
    sourceId: text(row.source_id, "artifact source"),
    relativePath: text(row.relative_path, "artifact path"),
    sourceRevision: text(row.source_revision, "artifact source revision"),
  }
}
