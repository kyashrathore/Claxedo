import { ensurePinnedClaude } from "./pinned-claude"
import { ensurePinnedCodex } from "./pinned-codex"
import { ensurePinnedPi } from "./pinned-pi"

await Promise.all([ensurePinnedPi(), ensurePinnedCodex(), ensurePinnedClaude()])
