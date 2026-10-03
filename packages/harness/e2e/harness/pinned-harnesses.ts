import { ensurePinnedClaude } from "./pinned-claude"
import { ensurePinnedCodex } from "./pinned-codex"

await Promise.all([ensurePinnedCodex(), ensurePinnedClaude()])
