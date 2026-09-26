import { asArray, isRecord } from "@claxedo/helpers/guards"
import type {
  MachineInstalled,
  MachineInstalledEntry,
  MachineInstalledHarness,
  MachineSkill,
  MachineSkillHarness,
  PluginSourceDiagnostic,
} from "../marketplace-types"

const ENTRY_HARNESSES: readonly MachineInstalledHarness["harnessId"][] = ["claude", "cursor", "codex"]
const SKILL_HARNESSES: readonly MachineSkillHarness[] = ["claude", "cursor", "codex", "opencode", "agents"]

function installedEntry(value: unknown): MachineInstalledEntry | undefined {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.root !== "string") return undefined
  return {
    name: value.name,
    ...(typeof value.version === "string" ? { version: value.version } : {}),
    root: value.root,
    ...(typeof value.marketplace === "string" ? { marketplace: value.marketplace } : {}),
    ownedByClaxedo: value.ownedByClaxedo === true,
  }
}

function harness(value: unknown): MachineInstalledHarness | undefined {
  if (!isRecord(value)) return undefined
  const harnessId = ENTRY_HARNESSES.find((id) => id === value.harnessId)
  if (!harnessId) return undefined
  return { harnessId, entries: asArray(value.entries).flatMap((row) => installedEntry(row) ?? []) }
}

function skill(value: unknown): MachineSkill | undefined {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.root !== "string") return undefined
  const harnessId = SKILL_HARNESSES.find((id) => id === value.harnessId)
  return harnessId ? { name: value.name, harnessId, root: value.root } : undefined
}

export function machineInstalledFromWire(value: unknown): MachineInstalled {
  const body = isRecord(value) ? value : {}
  return {
    harnesses: asArray(body.harnesses).flatMap((row) => harness(row) ?? []),
    skills: asArray(body.skills).flatMap((row) => skill(row) ?? []),
  }
}

export function sourceDiagnosticsFromWire(value: unknown): readonly PluginSourceDiagnostic[] {
  const error = isRecord(value) && isRecord(value.error) ? value.error : undefined
  return asArray(error?.diagnostics).flatMap((item) =>
    isRecord(item) &&
    typeof item.sourceId === "string" &&
    typeof item.relativePath === "string" &&
    typeof item.code === "string" &&
    typeof item.message === "string"
      ? [{ sourceId: item.sourceId, relativePath: item.relativePath, code: item.code, message: item.message }]
      : [],
  )
}
