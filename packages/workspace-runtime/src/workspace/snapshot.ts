import fs from "fs"
import path from "path"
import type { CredentialSnapshot, ProviderProjection } from "@claxedo/agent-runtime-contract"
import { acpConnectionConfig, piRpcConnectionConfig, type ConnectionConfigHooks } from "@claxedo/harness/providers"
import { rec, str } from "../json-value"
import { RuntimeConfigApplyError, type AppliedRuntimeSnapshot, type RuntimeConnectionDescriptor, type RuntimeHarnessSelection } from "../routes/config"
import type { RuntimeConfigApplyStatus } from "./host"

const CONNECTION_CONFIGS: readonly ConnectionConfigHooks<unknown>[] = [acpConnectionConfig(), piRpcConnectionConfig()]

/** The built-in connection providers plus the ones a host installs, in lookup order. */
export function connectionConfigHooks(custom: readonly ConnectionConfigHooks<unknown>[] = []): readonly ConnectionConfigHooks<unknown>[] {
  return [...CONNECTION_CONFIGS, ...custom]
}

export type RuntimeRunner = { id: string; access: "native" | "connection" }

export function runnerForSelection(selection: RuntimeHarnessSelection): RuntimeRunner {
  return selection.kind === "native"
    ? { id: selection.harnessId, access: "native" }
    : { id: selection.connectionId, access: "connection" }
}

export function harnessKey(harness: RuntimeRunner) {
  return `${harness.id}:${harness.access}`
}

export function errorMessage(input: unknown) {
  if (input instanceof Error) return input.message
  const row = rec(input)
  if (!row) return String(input)
  const message = str(rec(row.data)?.message) ?? str(row.message)
  if (message) return message
  try {
    return JSON.stringify(input)
  } catch {
    return String(input)
  }
}

/** Every descriptor the snapshot carries, validated by its provider's own config hook. */
export function validateDescriptors(
  rows: readonly RuntimeConnectionDescriptor[],
  hooks: readonly ConnectionConfigHooks<unknown>[] = CONNECTION_CONFIGS,
): Map<string, RuntimeConnectionDescriptor> {
  const validated = new Map<string, RuntimeConnectionDescriptor>()
  for (const row of rows) {
    const provider = hooks.find((candidate) => candidate.providerKey === row.providerKey)
    if (!provider) {
      throw new RuntimeConfigApplyError("runtime_config_provider_unknown", `Connection ${row.connectionId} names an unknown provider ${row.providerKey}`, 409)
    }
    try {
      validated.set(row.connectionId, { ...row, config: provider.validateConfig(row.config) })
    } catch (error) {
      throw new RuntimeConfigApplyError("runtime_config_connection_invalid", `Connection ${row.connectionId} is invalid: ${errorMessage(error)}`, 409)
    }
  }
  return validated
}

/** A descriptor's revision never moves backwards under one connection id. */
export function assertConnectionRevision(updated: RuntimeConnectionDescriptor, previous: RuntimeConnectionDescriptor) {
  if (updated.configRevision < previous.configRevision) {
    throw new RuntimeConfigApplyError("runtime_config_revision_regressed",
      `Connection ${updated.connectionId} revision ${updated.configRevision} is older than the applied ${previous.configRevision}`, 409)
  }
}

export function sameRuntimeMcp(a: Record<string, unknown>, b: Record<string, unknown>) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    if (JSON.stringify(canonicalJson(a[key])) !== JSON.stringify(canonicalJson(b[key]))) return false
  }
  return true
}

export function canonicalJson(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(canonicalJson)
  const row = rec(input)
  if (!row) return input
  return Object.fromEntries(Object.keys(row).sort().map((key) => [key, canonicalJson(row[key])]))
}

export function runtimeSnapshotSignature(snapshot: AppliedRuntimeSnapshot) {
  return JSON.stringify(canonicalJson(snapshot))
}

export function sameAuth(a: CredentialSnapshot<ProviderProjection>, b: CredentialSnapshot<ProviderProjection>) {
  return JSON.stringify(canonicalJson(a)) === JSON.stringify(canonicalJson(b))
}

function runtimeConfigSnapshotMetadata(snapshot: AppliedRuntimeSnapshot) {
  return {
    version: snapshot.version,
    ...(snapshot.defaultHarness ? { defaultHarness: snapshot.defaultHarness } : {}),
    connections: snapshot.connections.map(({ connectionId, providerKey, configRevision, enabled }) => ({
      connectionId,
      providerKey,
      configRevision,
      enabled,
    })),
    mcp: { keys: Object.keys(snapshot.mcp).sort() },
    auth: { machineOwnerUserId: snapshot.auth.machineOwnerUserId, users: Object.keys(snapshot.auth.accounts).sort() },
    ...(snapshot.harnessLaunch ? { harnessLaunch: Object.keys(snapshot.harnessLaunch).sort() } : {}),
    ...(snapshot.workspaceHarnessEnabled !== undefined ? { workspaceHarnessEnabled: snapshot.workspaceHarnessEnabled } : {}),
    ...(snapshot.commands ? { commands: snapshot.commands.map((command) => command.name).sort() } : {}),
  }
}

/**
 * Receipts are opt-in. Without a host-supplied directory there is nothing to
 * write: `configApply` is already live on `host.detail()`/`/api/wr/health`,
 * and deriving a path from the workspace would put local operational state
 * (revision counters, timestamps) in the user's source tree.
 */
export async function persistRuntimeConfigApplyStatus(input: {
  receiptDir?: string
  status: RuntimeConfigApplyStatus
  snapshot?: AppliedRuntimeSnapshot
}) {
  if (!input.receiptDir) return
  try {
    const root = input.receiptDir
    await fs.promises.mkdir(root, { recursive: true, mode: 0o755 })
    if (input.snapshot) {
      await fs.promises.writeFile(
        path.join(root, "accepted-snapshot.json"),
        JSON.stringify({
          revision: input.status.revision,
          acceptedAt: input.status.acceptedAt,
          snapshot: runtimeConfigSnapshotMetadata(input.snapshot),
        }, null, 2) + "\n",
        { mode: 0o600 },
      )
    }
    await fs.promises.writeFile(
      path.join(root, "apply-status.json"),
      JSON.stringify(input.status, null, 2) + "\n",
      { mode: 0o600 },
    )
  } catch {
    throw new RuntimeConfigApplyError(
      "runtime_config_apply_status_persist_failed",
      "Runtime config apply status could not be persisted",
      500,
    )
  }
}

export function runtimeConfigApplyError(input: unknown): RuntimeConfigApplyStatus["error"] {
  if (input instanceof RuntimeConfigApplyError) {
    return {
      code: input.code,
      message: input.message,
      ...(input.details ? { details: input.details } : {}),
    }
  }
  return {
    code: "runtime_snapshot_apply_failed",
    message: "Runtime config apply failed",
  }
}
