import { harnessForProviderId, HARNESS_TABLE } from "@claxedo/agent-runtime-contract"
import type { NativeHarnessId } from "@/lib/harness-selection"

type HarnessEntry = {
  label: string
  vendor: string
  icon: string
  connectProvider?: string
  vendorProvider?: string
}

export const HARNESS_CATALOG = {
  claude: { ...HARNESS_TABLE.claude, icon: "anthropic" },
  codex: { ...HARNESS_TABLE.codex, icon: "openai" },
  cursor: { ...HARNESS_TABLE.cursor, icon: "cursor" },
  pi: { label: "Pi", vendor: "Pi", icon: "pi" },
  opencode: { label: "OpenCode", vendor: "OpenCode", icon: "opencode" },
} as const satisfies Record<NativeHarnessId, HarnessEntry>

function entry(id: string): HarnessEntry | undefined {
  return (HARNESS_CATALOG as Record<string, HarnessEntry | undefined>)[id]
}

export function harnessLabel(id: string): string | undefined {
  return entry(id)?.label
}

export function harnessDisplayLabel(key: string): string {
  const known = harnessLabel(key)
  if (known) return known
  return key
    .split(/[-_]/g)
    .filter(Boolean)
    .map((item) => item[0]?.toUpperCase() + item.slice(1))
    .join(" ")
}

export type ConnectContext =
  | { kind: "harness"; harness: string; vendor: string }
  | { kind: "engine"; engine: string; vendor: string }

export function connectVars(context: ConnectContext): Record<string, string> {
  return context.kind === "harness"
    ? { harness: context.harness, vendor: context.vendor }
    : { engine: context.engine, vendor: context.vendor }
}

export function connectSubject(context: ConnectContext): string {
  return context.kind === "harness" ? context.harness : context.vendor
}

export function harnessConnectContext(harness: string, fallbackLabel?: string): ConnectContext {
  const known = entry(harness)
  const label = known?.label ?? fallbackLabel ?? harness
  return { kind: "harness", harness: label, vendor: known?.vendor ?? label }
}

export function engineConnectContext(engine: string, vendor: string): ConnectContext {
  return { kind: "engine", engine: harnessLabel(engine) ?? engine, vendor }
}

export function harnessIcon(id: string): string {
  return entry(id)?.icon ?? id
}

export function harnessLabelForProviderId(providerId: string): string | undefined {
  return harnessLabel(harnessForProviderId(providerId) ?? providerId)
}

export function harnessForConnectProvider(providerId: string): string | undefined {
  return Object.keys(HARNESS_CATALOG).find((id) => entry(id)?.connectProvider === providerId)
}

export function connectContextFor(input: { providerId: string; engine: string; vendor: string }): ConnectContext {
  const harness = harnessForConnectProvider(input.providerId)
  return harness ? harnessConnectContext(harness) : engineConnectContext(input.engine, input.vendor)
}
