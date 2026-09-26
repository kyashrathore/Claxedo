import { createSignal, type Accessor } from "solid-js"
import { PLUGIN_CAPABILITIES, type PluginCapability } from "@claxedo/plugin-api"
import { persistedSignal, preferenceKey } from "@/lib/persisted"
import { isRecord } from "@claxedo/helpers/guards"
import { isStringList } from "@/lib/record"
import type { Approval } from "./approval"

type PluginSwitches = { readonly off: readonly string[] }
type PluginApprovals = Readonly<Record<string, Approval>>

export type PluginPreferences = {
  readonly switchedOn: (pluginId: string) => boolean
  readonly setSwitchedOn: (pluginId: string, on: boolean) => void
  readonly approval: (pluginId: string) => Approval | undefined
  readonly approve: (pluginId: string, approval: Approval) => void
  readonly forget: (pluginId: string) => void
  readonly safeMode: Accessor<boolean>
  readonly leaveSafeMode: () => void
}

const NO_SWITCHES: PluginSwitches = { off: [] }
const NO_APPROVALS: PluginApprovals = {}

function isPluginCapability(value: string): value is PluginCapability {
  return (PLUGIN_CAPABILITIES as readonly string[]).includes(value)
}

function readSwitches(value: unknown): PluginSwitches | undefined {
  return isRecord(value) && isStringList(value.off) ? { off: value.off } : undefined
}

function readApproval(value: unknown): Approval | undefined {
  if (!isRecord(value) || !isRecord(value.access) || typeof value.hash !== "string" || typeof value.approvedAt !== "string") return undefined
  const { routes, operations, requires } = value.access
  if (!isStringList(routes) || !isStringList(operations) || !isStringList(requires)) return undefined
  if (!requires.every(isPluginCapability)) return undefined
  return { access: { routes, operations, requires }, hash: value.hash, approvedAt: value.approvedAt }
}

function readApprovals(value: unknown): PluginApprovals | undefined {
  if (!isRecord(value)) return undefined
  const approvals: Record<string, Approval> = {}
  for (const [pluginId, entry] of Object.entries(value)) {
    const approval = readApproval(entry)
    if (!approval) return undefined
    approvals[pluginId] = approval
  }
  return approvals
}

function withoutId(list: readonly string[], id: string): readonly string[] {
  return list.filter((entry) => entry !== id)
}

function withoutApproval(approvals: PluginApprovals, id: string): PluginApprovals {
  return Object.fromEntries(Object.entries(approvals).filter(([pluginId]) => pluginId !== id))
}

export function safeModeRequested(search: string): boolean {
  return new URLSearchParams(search).has("safe-mode")
}

export function createPluginPreferences(scope: string, safeModeAtStart: boolean): PluginPreferences {
  const [switches, setSwitches] = persistedSignal(preferenceKey("plugins", scope), NO_SWITCHES, readSwitches)
  const [approvals, setApprovals] = persistedSignal(preferenceKey("plugin-approvals", scope), NO_APPROVALS, readApprovals)
  const [safeMode, setSafeMode] = createSignal(safeModeAtStart)
  return {
    switchedOn: (pluginId) => !switches().off.includes(pluginId),
    setSwitchedOn: (pluginId, on) => setSwitches((current) => ({ off: on ? withoutId(current.off, pluginId) : [...withoutId(current.off, pluginId), pluginId] })),
    approval: (pluginId) => approvals()[pluginId],
    approve: (pluginId, approval) => setApprovals((current) => ({ ...current, [pluginId]: approval })),
    forget: (pluginId) => {
      setSwitches((current) => ({ off: withoutId(current.off, pluginId) }))
      setApprovals((current) => withoutApproval(current, pluginId))
    },
    safeMode,
    leaveSafeMode: () => setSafeMode(false),
  }
}
