import type {
  MachineInstalled,
  MachineInstalledEntry,
  MachineInstalledHarness,
  MachineSkill,
  MachineSkillHarness,
  PluginSourceDiagnostic,
} from "../marketplace-types"

type Row = Record<string, unknown>

const ENTRY_HARNESSES: readonly MachineInstalledHarness["harnessId"][] = ["claude", "cursor", "codex"]
const SKILL_HARNESSES: readonly MachineSkillHarness[] = ["claude", "cursor", "codex", "opencode", "agents"]

function record(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function rows(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function entry(value: unknown): MachineInstalledEntry | undefined {
  if (!record(value) || typeof value.name !== "string" || typeof value.root !== "string") return undefined
  return {
    name: value.name,
    ...(typeof value.version === "string" ? { version: value.version } : {}),
    root: value.root,
    ...(typeof value.marketplace === "string" ? { marketplace: value.marketplace } : {}),
    ownedByClaxedo: value.ownedByClaxedo === true,
  }
}

function harness(value: unknown): MachineInstalledHarness | undefined {
  if (!record(value)) return undefined
  const harnessId = ENTRY_HARNESSES.find((id) => id === value.harnessId)
  if (!harnessId) return undefined
  return { harnessId, entries: rows(value.entries).flatMap((row) => entry(row) ?? []) }
}

function skill(value: unknown): MachineSkill | undefined {
  if (!record(value) || typeof value.name !== "string" || typeof value.root !== "string") return undefined
  const harnessId = SKILL_HARNESSES.find((id) => id === value.harnessId)
  return harnessId ? { name: value.name, harnessId, root: value.root } : undefined
}

export function machineInstalledFromWire(value: unknown): MachineInstalled {
  const body = record(value) ? value : {}
  return {
    harnesses: rows(body.harnesses).flatMap((row) => harness(row) ?? []),
    skills: rows(body.skills).flatMap((row) => skill(row) ?? []),
  }
}

export function sourceDiagnosticsFromWire(value: unknown): readonly PluginSourceDiagnostic[] {
  const error = record(value) && record(value.error) ? value.error : undefined
  return rows(error?.diagnostics).flatMap((item) =>
    record(item) &&
    typeof item.sourceId === "string" &&
    typeof item.relativePath === "string" &&
    typeof item.code === "string" &&
    typeof item.message === "string"
      ? [{ sourceId: item.sourceId, relativePath: item.relativePath, code: item.code, message: item.message }]
      : [],
  )
}
