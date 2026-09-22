import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { trimToUndefined } from "@claxedo/helpers/string"

/** A workspace id as one path segment; the id itself may contain separators. */
function piWorkspaceDirName(workspaceId: string | undefined) {
  return workspaceId ? createHash("sha256").update(workspaceId).digest("hex").slice(0, 16) : "default"
}

/**
 * The Pi profile directory, resolved once so the driver never has to guess.
 *
 * The default is scoped to the workspace because the profile holds
 * `models.json`, and that file carries the broker placeholder: one shared
 * profile would let the workspace that applied last hand its binding to every
 * other workspace's turns.
 */
export type PiAgentDirInput = { agentDir?: string; storeRoot?: string; workspaceId?: string }

export function piAgentDir(options: PiAgentDirInput): string {
  return options.agentDir
    ?? (options.storeRoot ? path.join(options.storeRoot, "pi", "agent") : undefined)
    ?? trimToUndefined(process.env.PI_CODING_AGENT_DIR)
    ?? path.join(os.homedir(), ".claxedo", "pi", "agent", piWorkspaceDirName(options.workspaceId))
}
