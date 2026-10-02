import { CODEX_RANGE } from "../../src/transports/codex-app-server/version"
import { ensurePinned, pinnedBin, rangeEnd, type PinnedPackage } from "./pinned-package"

const CODEX: PinnedPackage = { label: "codex", npmPackage: "@openai/codex", bin: "codex", version: rangeEnd(CODEX_RANGE, "CLAXEDO_E2E_CODEX") }

export const PINNED_CODEX = pinnedBin(CODEX)

export function ensurePinnedCodex(): Promise<{ installed: boolean; version: string }> {
  return ensurePinned(CODEX)
}
