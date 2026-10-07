import path from "node:path"
import { CODEX_RANGE } from "../../src/transports/codex-app-server/version"
import { ensurePinned, pinnedBin, rangeEnd, type PinnedPackage } from "./pinned-package"

const WINDOWS_TARGETS: Partial<Record<NodeJS.Architecture, string>> = { x64: "x86_64-pc-windows-msvc", arm64: "aarch64-pc-windows-msvc" }

function windowsCodex(nodeModules: string): string {
  const target = WINDOWS_TARGETS[process.arch]
  if (!target) throw new Error(`@openai/codex ships no Windows binary for ${process.arch}`)
  return path.join(nodeModules, "@openai", `codex-win32-${process.arch}`, "vendor", target, "bin", "codex.exe")
}

const CODEX: PinnedPackage = { label: "codex", npmPackage: "@openai/codex", bin: "codex", version: rangeEnd(CODEX_RANGE, "CLAXEDO_E2E_CODEX"),
  windowsExecutable: windowsCodex }

export const PINNED_CODEX = pinnedBin(CODEX)

export function ensurePinnedCodex(): Promise<{ installed: boolean; version: string }> {
  return ensurePinned(CODEX)
}
