import { isHarnessSelection, type HarnessSelection } from "../../lib/harness-selection"
import { asRecord } from "@claxedo/helpers/guards"
import type { HarnessConnectionState, HarnessHealth, HarnessState, SessionConfig } from "../harness-types"

const harnessStatuses: readonly unknown[] = ["configured", "ready", "applying", "error"] satisfies readonly NonNullable<HarnessState["status"]>[]
const connectionStates: readonly unknown[] = ["configured", "connecting", "ready", "auth-required", "disconnected", "failed"] satisfies readonly HarnessConnectionState["state"][]

function isHarnessStatus(value: unknown): value is NonNullable<HarnessState["status"]> {
  return harnessStatuses.includes(value)
}

function isConnectionState(value: unknown): value is HarnessConnectionState["state"] {
  return connectionStates.includes(value)
}

function harnessSelectionFromWire(value: unknown): HarnessSelection | undefined {
  if (isHarnessSelection(value)) return value
  const row = asRecord(value)
  if (!row || typeof row.id !== "string" || !row.id.trim()) return undefined
  if (row.access === "connection") return { kind: "connection", connectionId: row.id }
  if (row.access === "native" && (row.id === "claude" || row.id === "codex" || row.id === "cursor" || row.id === "pi" || row.id === "opencode")) {
    return { kind: "native", harnessId: row.id }
  }
  return undefined
}

export function connectionStateFromWire(value: unknown): HarnessConnectionState | undefined {
  const row = asRecord(value)
  if (!row || typeof row.connectionId !== "string" || !row.connectionId || !isConnectionState(row.state)) return undefined
  return { connectionId: row.connectionId, state: row.state }
}

export function harnessHealthFromWire(value: unknown): HarnessHealth | undefined {
  const row = asRecord(value)
  if (!row || (row.status !== "ok" && row.status !== "degraded" && row.status !== "unavailable")) return undefined
  return { status: row.status, ...(typeof row.reason === "string" ? { reason: row.reason } : {}) }
}

export function harnessStateFromWire(value: unknown): HarnessState | undefined {
  const row = asRecord(value)
  if (!row) return undefined
  const type = harnessSelectionFromWire(row.harness)
  const activeType = harnessSelectionFromWire(row.activeHarness)
  const harnessHealth = harnessHealthFromWire(row.harnessHealth)
  const connectionState = connectionStateFromWire(row.connectionState)
  return {
    ...(type ? { type } : {}),
    ...(typeof row.model === "string" || row.model === null ? { model: row.model } : {}),
    ...(typeof row.modelProviderID === "string" || row.modelProviderID === null ? { modelProviderId: row.modelProviderID } : {}),
    ...(activeType ? { activeType } : {}),
    ...(isHarnessStatus(row.status) ? { status: row.status } : {}),
    ...(typeof row.error === "string" ? { error: row.error } : {}),
    ...(typeof row.ready === "boolean" ? { ready: row.ready } : {}),
    ...(typeof row.workspaceId === "string" ? { workspaceId: row.workspaceId } : {}),
    ...(harnessHealth ? { harnessHealth } : {}),
    ...(connectionState ? { connectionState } : {}),
  }
}

export function sessionConfigFromWire(value: unknown): SessionConfig | undefined {
  const row = asRecord(value)
  if (!row) return undefined
  const model = asRecord(row.model)
  const harness = harnessStateFromWire({ harness: row.harness, activeHarness: row.harness })
  return {
    ...(harness ? { harness } : {}),
    model: model && (typeof model.modelID === "string" || model.modelID === null)
      ? { modelId: model.modelID, ...(typeof model.providerID === "string" || model.providerID === null ? { providerId: model.providerID } : {}) }
      : null,
    ...(typeof row.variant === "string" && row.variant ? { variant: row.variant } : {}),
    ...(typeof row.permissionMode === "string" && row.permissionMode ? { permissionMode: row.permissionMode } : {}),
  }
}
