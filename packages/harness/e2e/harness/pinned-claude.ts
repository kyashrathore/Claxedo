import { CLAUDE_CODE_RANGE } from "../../src/transports/claude-sdk/cli-version"
import { ensurePinned, pinnedBin, rangeEnd, type PinnedPackage } from "./pinned-package"

const CLAUDE: PinnedPackage = { label: "claude", npmPackage: "@anthropic-ai/claude-code", bin: "claude",
  version: rangeEnd(CLAUDE_CODE_RANGE, "CLAXEDO_E2E_CLAUDE") }

export const PINNED_CLAUDE = pinnedBin(CLAUDE)

export function ensurePinnedClaude(): Promise<{ installed: boolean; version: string }> {
  return ensurePinned(CLAUDE)
}
