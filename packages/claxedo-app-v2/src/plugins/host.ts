import { createMemo, createSignal, type Accessor } from "solid-js"
import type { PluginCapability } from "@claxedo/plugin-api"
import { approvalCheck, approvalFor, approvalLetsRun, type ApprovalCheck } from "./approval"
import { createPluginLifecycle, type Activate, type PluginLifecycle } from "./lifecycle"
import type { PluginBuild, PluginSummary } from "./model"
import type { PluginPreferences } from "./preferences"

export type PluginHostDeps = {
  readonly preferences: PluginPreferences
  readonly offered: (capability: PluginCapability) => boolean
  readonly activate: Activate
  readonly removeLive: (pluginId: string) => Promise<void>
}

export type PluginHost = {
  readonly plugins: Accessor<readonly PluginSummary[]>
  readonly required: Accessor<ReadonlySet<PluginCapability>>
  readonly put: (build: PluginBuild) => void
  readonly drop: (pluginId: string) => void
  readonly switchOn: (pluginId: string) => void
  readonly switchOff: (pluginId: string) => void
  readonly approve: (pluginId: string, hash: string) => boolean
  readonly remove: (pluginId: string) => Promise<void>
  readonly safeMode: Accessor<boolean>
  readonly leaveSafeMode: () => void
  readonly dispose: () => void
}

type BuildPolicy = {
  readonly missing: (build: PluginBuild) => readonly PluginCapability[]
  readonly approval: (build: PluginBuild) => ApprovalCheck
  readonly wanted: (build: PluginBuild) => boolean
}

function createBuildPolicy(deps: PluginHostDeps): BuildPolicy {
  const { preferences } = deps
  const missing = (build: PluginBuild): readonly PluginCapability[] =>
    build.manifest.requires.filter((capability) => !deps.offered(capability))
  const approval = (build: PluginBuild): ApprovalCheck => {
    if (build.origin.kind === "bundled") return { kind: "approved" }
    if (build.origin.builtAt === undefined) return { kind: "unapproved" }
    return approvalCheck(preferences.approval(build.manifest.id), { manifest: build.manifest, hash: build.origin.hash, builtAt: build.origin.builtAt })
  }
  const wanted = (build: PluginBuild) => {
    if (!preferences.switchedOn(build.manifest.id) || missing(build).length > 0) return false
    return build.origin.kind === "bundled" || (!preferences.safeMode() && approvalLetsRun(approval(build)))
  }
  return { missing, approval, wanted }
}

function summaryOf(lifecycle: PluginLifecycle, policy: BuildPolicy, preferences: PluginPreferences): PluginSummary {
  const build = lifecycle.build()
  return {
    id: lifecycle.id,
    name: build.manifest.name,
    version: build.manifest.version,
    manifest: build.manifest,
    origin: build.origin,
    switchedOn: preferences.switchedOn(lifecycle.id),
    missing: policy.missing(build),
    approval: policy.approval(build),
    state: lifecycle.state(),
  }
}

function approveBuild(preferences: PluginPreferences, build: PluginBuild | undefined, pluginId: string, hash: string): boolean {
  if (build?.origin.kind !== "live" || build.origin.hash !== hash || build.origin.builtAt === undefined) return false
  preferences.approve(pluginId, approvalFor({ manifest: build.manifest, hash, builtAt: build.origin.builtAt }, new Date()))
  return true
}

export function createPluginHost(deps: PluginHostDeps): PluginHost {
  const { preferences } = deps
  const policy = createBuildPolicy(deps)
  const [lifecycles, setLifecycles] = createSignal<readonly PluginLifecycle[]>([])
  const summaries = createMemo<readonly PluginSummary[]>(() => lifecycles().map((lifecycle) => summaryOf(lifecycle, policy, preferences)))
  const required = createMemo<ReadonlySet<PluginCapability>>(() => new Set(lifecycles().flatMap((lifecycle) => lifecycle.build().manifest.requires)))
  const find = (pluginId: string) => lifecycles().find((lifecycle) => lifecycle.id === pluginId)
  const drop = (pluginId: string) => {
    const lifecycle = find(pluginId)
    if (!lifecycle) return
    lifecycle.dispose()
    setLifecycles((current) => current.filter((candidate) => candidate !== lifecycle))
  }
  return {
    plugins: summaries,
    required,
    put: (build) => {
      const existing = find(build.manifest.id)
      if (existing) return existing.setBuild(build)
      setLifecycles((current) => [...current, createPluginLifecycle(build, policy.wanted, deps.activate)])
    },
    drop,
    remove: async (pluginId) => {
      await deps.removeLive(pluginId)
      drop(pluginId)
      preferences.forget(pluginId)
    },
    switchOn: (pluginId) => preferences.setSwitchedOn(pluginId, true),
    switchOff: (pluginId) => preferences.setSwitchedOn(pluginId, false),
    approve: (pluginId, hash) => approveBuild(preferences, find(pluginId)?.build(), pluginId, hash),
    safeMode: preferences.safeMode,
    leaveSafeMode: preferences.leaveSafeMode,
    dispose: () => {
      for (const lifecycle of lifecycles()) lifecycle.dispose()
      setLifecycles([])
    },
  }
}
