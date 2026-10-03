import { CodexProcessPool, CursorHostRegistry } from "@claxedo/harness/compose"
import type { HarnessServices } from "@claxedo/harness/contract"

/** The harness processes one runtime process shares across its workspaces: Codex app-servers by launch key, Cursor SDK hosts by binding and home. */
export type SharedHarnessHosts = { codex: CodexProcessPool; cursor: CursorHostRegistry; dispose(): Promise<void> }

export function createSharedHarnessHosts(input: Pick<HarnessServices, "clock" | "log">): SharedHarnessHosts {
  const codex = new CodexProcessPool({ clock: input.clock, log: input.log })
  const cursor = new CursorHostRegistry(input.clock, input.log)
  return { codex, cursor, dispose: async () => { await Promise.all([codex.dispose(), cursor.dispose()]) } }
}
