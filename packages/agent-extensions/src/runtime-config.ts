import type { WorkspaceAgentExtensionRecord } from "./workspace"
import {
  allHarnessTargets,
  FIRST_PARTY_AGENT_EXTENSION_ID,
  FIRST_PARTY_AGENT_EXTENSION_PACKAGE_NAME,
  FIRST_PARTY_AGENT_EXTENSIONS_DIR,
  type MaterializedAgentExtensionScope,
} from "./types"
import { discoverAgentExtensionComponents } from "./discovery"
import {
  agentExtensionStateRoot,
  installedStatePath,
  readDesiredExtensionState,
  type DesiredExtensionInstall,
} from "./state"
import { lockStatePath, readExtensionLock, type LockedExtensionPackage } from "./lock"
import { sameSource } from "./source"
import {
  materializedRecordPath,
  readMaterializedRuntimeRecord,
  type MaterializedComponent,
} from "./materialization"
import path from "path"

export type RuntimeAgentExtensionsSnapshot = {
  version: 1
  installs: Array<{
    desired: DesiredExtensionInstall
    lock?: LockedExtensionPackage
    status?: string
    effective: EffectiveAgentExtensionPolicy
    components: Array<Pick<MaterializedComponent, "runner" | "component" | "type" | "status" | "reason" | "checksum">>
  }>
}

export type AgentExtensionPolicyOverride = {
  id: string
  scope: "org" | "user" | "workspace"
  enabled: boolean
  reason?: string
}

export type EffectiveAgentExtensionPolicy = {
  enabled: boolean
  source: "desired" | "org" | "user" | "workspace"
  reason?: string
}

export type RuntimeAgentExtensionsSnapshotInput = {
  projectDir: string
  scope?: MaterializedAgentExtensionScope
  dataRoot?: string
}

export type RuntimeAgentExtensionsSnapshotOptions = {
  workspaceInstalls?: WorkspaceAgentExtensionRecord[]
  policyOverrides?: AgentExtensionPolicyOverride[]
}

async function discoverFirstPartyAgentExtensions(projectDir: string): Promise<DesiredExtensionInstall | undefined> {
  if ((await discoverAgentExtensionComponents(path.join(projectDir, FIRST_PARTY_AGENT_EXTENSIONS_DIR))).length === 0) {
    return undefined
  }
  return {
    id: FIRST_PARTY_AGENT_EXTENSION_ID,
    package_name: FIRST_PARTY_AGENT_EXTENSION_PACKAGE_NAME,
    source: {
      type: "project",
      package_path: FIRST_PARTY_AGENT_EXTENSIONS_DIR,
    },
    scope: "project",
    enabled: true,
    targets: allHarnessTargets(),
    installed_at: 0,
    updated_at: 0,
  }
}

function overrideFor(overrides: AgentExtensionPolicyOverride[], id: string, scope: AgentExtensionPolicyOverride["scope"]) {
  return overrides.find((item) => item.id === id && item.scope === scope)
}

export function resolveEffectiveAgentExtensionPolicy(
  desired: DesiredExtensionInstall,
  overrides: AgentExtensionPolicyOverride[] = [],
): EffectiveAgentExtensionPolicy {
  if (!desired.enabled) return { enabled: false, source: "desired", reason: "desired install is disabled" }
  const org = overrideFor(overrides, desired.id, "org")
  if (org?.enabled === false) {
    return {
      enabled: false,
      source: "org",
      ...(org.reason ? { reason: org.reason } : {}),
    }
  }
  const workspace = overrideFor(overrides, desired.id, "workspace")
  if (workspace) {
    return {
      enabled: workspace.enabled,
      source: "workspace",
      ...(workspace.reason ? { reason: workspace.reason } : {}),
    }
  }
  const user = overrideFor(overrides, desired.id, "user")
  if (user) {
    return {
      enabled: user.enabled,
      source: "user",
      ...(user.reason ? { reason: user.reason } : {}),
    }
  }
  if (org) {
    return {
      enabled: org.enabled,
      source: "org",
      ...(org.reason ? { reason: org.reason } : {}),
    }
  }
  return { enabled: true, source: "desired" }
}

export async function getRuntimeAgentExtensionsSnapshot(
  input: RuntimeAgentExtensionsSnapshotInput,
  options: RuntimeAgentExtensionsSnapshotOptions = {},
): Promise<RuntimeAgentExtensionsSnapshot> {
  const config = {
    projectDir: input.projectDir,
    scope: input.scope ?? "project",
    ...(input.dataRoot ? { dataRoot: input.dataRoot } : {}),
  }
  const stateLocation = {
    scope: config.scope,
    projectDir: config.projectDir,
    ...(config.dataRoot ? { dataRoot: config.dataRoot } : {}),
  }
  const root = agentExtensionStateRoot(stateLocation)
  const [desired, lock, materialized] = await Promise.all([
    readDesiredExtensionState(installedStatePath(stateLocation)),
    readExtensionLock(lockStatePath(root)),
    readMaterializedRuntimeRecord(materializedRecordPath(root)),
  ])
  const desiredInstalls = desired.installs.filter((item) =>
    config.scope !== "project" || item.id !== FIRST_PARTY_AGENT_EXTENSION_ID || item.source.type !== "project"
  )
  const firstParty = config.scope !== "project" || desiredInstalls.some((item) => item.id === FIRST_PARTY_AGENT_EXTENSION_ID)
    ? undefined
    : await discoverFirstPartyAgentExtensions(config.projectDir)
  // Local desired state is authoritative for installs it already tracks; a
  // workspace record with the same id would otherwise produce a duplicate
  // installed.json row on replay. A same-source record under a different id
  // (one side keyed by a legacy manifest-derived id, the other by the catalog
  // id) is the same install too: both build component paths from the shared
  // package_name, so replaying the second row could only lose the ownership
  // check.
  const localInstalls = [
    ...desiredInstalls,
    ...(firstParty ? [firstParty] : []),
  ]
  const localIds = new Set(localInstalls.map((item) => item.id))
  const workspace = (options.workspaceInstalls ?? []).filter((item) =>
    !localIds.has(item.desired.id)
    && !localInstalls.some((local) => sameSource(local.source, item.desired.source)))
  const installs: Array<{
    desired: DesiredExtensionInstall
    lock?: LockedExtensionPackage
    status?: string
    components: MaterializedComponent[]
  }> = [
    ...desiredInstalls.map((item) => ({
      desired: item,
      lock: lock.packages[item.id],
      status: materialized.packages[item.id]?.status,
      components: materialized.packages[item.id]?.components ?? [],
    })),
    ...(firstParty ? [{
      desired: firstParty,
      status: materialized.packages[firstParty.id]?.status,
      components: materialized.packages[firstParty.id]?.components ?? [],
    }] : []),
    ...workspace.map((item) => ({
      desired: item.desired,
      lock: item.lock,
      components: [] as MaterializedComponent[],
    })),
  ]
  return {
    version: 1,
    // Disabled installs stay in the snapshot with enabled=false. Replay treats
    // the snapshot as the whole world, so dropping them would erase their
    // desired/lock state and delete their artifacts as stale — disable would
    // become uninstall. Effective policy is folded into desired.enabled so the
    // replaying runtime never materializes a policy-blocked install.
    installs: installs
      .map((item) => ({
        ...item,
        effective: resolveEffectiveAgentExtensionPolicy(item.desired, options.policyOverrides),
      }))
      .map((item) => ({
        desired: item.effective.enabled === item.desired.enabled
          ? item.desired
          : { ...item.desired, enabled: item.effective.enabled },
        ...(item.lock ? { lock: item.lock } : {}),
        ...(item.status ? { status: item.status } : {}),
        effective: item.effective,
        components: item.components.map((component) => ({
          runner: component.runner,
          component: component.component,
          type: component.type,
          status: component.status,
          ...(component.reason ? { reason: component.reason } : {}),
          ...(component.checksum ? { checksum: component.checksum } : {}),
        })),
      })),
  }
}
